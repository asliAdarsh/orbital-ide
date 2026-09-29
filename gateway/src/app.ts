/**
 * The gateway's HTTP surface.
 *
 * Everything here is plain Express, `fetch` and the Admin SDK. Nothing on this path imports the
 * functions runtime — `index.ts` is the only file that does — which is what lets the tests drive the
 * real gateway over a real socket with real emulator-backed identity and real Firestore, instead of
 * a mock that agrees with itself.
 *
 * Two contracts hold everywhere below. The bytes the client receives on a successful response are
 * the upstream's bytes, and every refusal is OpenAI-shaped, because the desktop client reads
 * `error.message` out of that shape and shows it to a person.
 */

import { once } from "node:events";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response as ExpressResponse,
} from "express";
import { requireCaller } from "./auth";
import {
  ALLOWED_MODELS,
  catalogueFor,
  CATALOGUE,
  MAX_IN_FLIGHT_PER_ACCOUNT,
  MAX_TOKENS_CLAMP,
  VERSION,
  type CatalogueEntry,
} from "./config";
import { creditsRemaining, readAccount, requireCredits, requireEntitlement, requirePlanModel } from "./entitlement";
import { failure, GatewayError, sendFailure, type Failure } from "./errors";
import { beginRequest, endRequest } from "./inflight";
import { sseErrorFrame, StreamScanner } from "./sse";
import { callUpstream, SESSION_HEADER, upstreamFailure } from "./upstream";
import { estimateUsage, recordUsage, usageFromCompletion, type TokenUsage } from "./usage";
import { asFiniteNumber, asRecord, jsonLength, parseJsonRecord, textLength } from "./values";

/** Whether the caller is still there. Flipped by the response's own `close`/`error` events. */
interface CallerState {
  clientGone: boolean;
}

/** What relaying needs, whichever way the upstream answered. */
interface RelayArgs {
  readonly upstream: Response;
  readonly res: ExpressResponse;
  readonly uid: string;
  readonly model: string;
  /** What this prompt costs, charged once when the completion has been delivered. */
  readonly credits: number;
  readonly body: Record<string, unknown>;
}

/** Input tokens are the prompt, and on an agent run the tool definitions are not a rounding error. */
function promptChars(body: Record<string, unknown>): number {
  return jsonLength(body.messages) + jsonLength(body.tools);
}

/** What a non-streamed completion cost: the upstream's own figure, or the documented estimate. */
function usageOfNonStream(body: Record<string, unknown>, text: string): TokenUsage {
  const parsed = parseJsonRecord(text);
  const reported = parsed === null ? null : usageFromCompletion(parsed);
  if (reported !== null) return reported;
  return estimateUsage(promptChars(body), textLength(parsed?.choices ?? null));
}

/**
 * The caller's body as it will be sent upstream: the model the catalogue resolved, and nothing else
 * changed. A body that is not a JSON object, or that asks for a model the catalogue does not serve,
 * is refused here rather than forwarded — the upstream's answer to either would be worse than a
 * sentence naming the problem.
 */
function resolveRequest(req: Request): { payload: Record<string, unknown>; entry: CatalogueEntry } {
  const body = asRecord(req.body as unknown);
  if (body === null) {
    throw new GatewayError(
      failure(
        400,
        "invalid_request_error",
        "invalid_body",
        "The Orbital gateway expects a JSON object as the chat-completions body.",
      ),
    );
  }

  const requested = body.model;
  if (typeof requested !== "string" || requested.length === 0) {
    throw new GatewayError(
      failure(
        400,
        "invalid_request_error",
        "model_required",
        `No model was requested. The Orbital gateway serves: ${ALLOWED_MODELS}.`,
      ),
    );
  }

  const entry = CATALOGUE.find((candidate) => candidate.id === requested);
  if (entry === undefined) {
    // Refused by name, never rewritten: running a different model than the one asked for would be a
    // silent lie about what produced the answer, and the catalogue is the source of truth for what
    // may be asked for at all.
    throw new GatewayError(
      failure(
        400,
        "invalid_request_error",
        "model_not_found",
        `The Orbital gateway does not serve ${JSON.stringify(requested)}. It serves: ${ALLOWED_MODELS}.`,
      ),
    );
  }
  return { payload: { ...body, model: entry.upstream }, entry };
}

async function chatCompletions(req: Request, res: ExpressResponse): Promise<void> {
  const uid = await requireCaller(req);

  // The plan checks need the model's cost, so the model is resolved first: a refusal that cannot
  // name what a prompt costs cannot tell the person how far short they are.
  const { payload, entry } = resolveRequest(req);
  const account = await requireEntitlement(uid);
  requirePlanModel(account, entry);
  requireCredits(account, entry);

  if (!beginRequest(uid)) {
    throw new GatewayError(
      failure(
        429,
        "rate_limit_error",
        "too_many_concurrent_requests",
        `This account already has ${MAX_IN_FLIGHT_PER_ACCOUNT} requests in flight on this gateway ` +
          "instance. Wait for one to finish and retry.",
      ),
    );
  }

  try {
    const asked = asFiniteNumber(payload.max_tokens);
    if (asked !== null && asked > MAX_TOKENS_CLAMP) {
      payload.max_tokens = MAX_TOKENS_CLAMP;
      // Said out loud rather than hidden: a client that asked for more can see the ceiling it got.
      res.setHeader("x-orbital-clamped-max-tokens", String(MAX_TOKENS_CLAMP));
    }

    const state: CallerState = { clientGone: false };
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) {
        state.clientGone = true;
        controller.abort();
      }
    });
    res.on("error", () => {
      state.clientGone = true;
      controller.abort();
    });

    let upstream: Response;
    try {
      upstream = await callUpstream({
        body: payload,
        sessionId: req.get(SESSION_HEADER) ?? null,
        uid,
        signal: controller.signal,
      });
    } catch (error) {
      // Nobody is listening any more, so there is nothing to report and no one to report it to.
      if (state.clientGone) return;
      const reason = error instanceof Error ? error.name : "network failure";
      throw new GatewayError(
        failure(
          502,
          "upstream_error",
          "upstream_unreachable",
          `The Orbital gateway could not reach its provider (${reason}). Retry shortly.`,
        ),
      );
    }

    if (!upstream.ok) {
      // Never the upstream's envelope verbatim: it is not addressed to this caller, and an upstream
      // that echoes the credential it rejected would leak the Orbital key through this gateway.
      throw new GatewayError(upstreamFailure(upstream.status, await upstream.text()));
    }

    const charge = { uid, model: entry.id, credits: entry.creditsPerPrompt, body: payload };
    if (payload.stream === true) {
      await relayStream({ ...charge, upstream, res, state });
    } else {
      await relayJson({ ...charge, upstream, res });
    }
  } finally {
    endRequest(uid);
  }
}

/** A non-streamed completion, forwarded as the bytes it arrived as. */
async function relayJson(args: RelayArgs): Promise<void> {
  const bytes = Buffer.from(await args.upstream.arrayBuffer());
  args.res.status(args.upstream.status);
  args.res.setHeader("content-type", args.upstream.headers.get("content-type") ?? "application/json");
  args.res.setHeader("content-length", String(bytes.byteLength));
  args.res.end(bytes);

  // After the bytes are on their way, so bookkeeping can never delay or break a completion the
  // caller already paid for. Awaited all the same: a promise dropped here would be a write that
  // silently never happened.
  await recordUsage(args.uid, args.model, usageOfNonStream(args.body, bytes.toString("utf8")), args.credits);
}

/** A streamed completion, relayed frame by frame, with the accounting read off a copy. */
async function relayStream(args: RelayArgs & { readonly state: CallerState }): Promise<void> {
  const { upstream, res, state, uid, model, credits, body } = args;

  res.status(200);
  res.setHeader("content-type", upstream.headers.get("content-type") ?? "text/event-stream");
  // Nothing between here and the client may buffer or transform these frames: this is a live stream,
  // and an intermediary that holds the first event until the last turns it into a slow response.
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();

  const reader = upstream.body?.getReader();
  if (reader === undefined) {
    res.write(
      sseErrorFrame(
        failure(
          502,
          "upstream_error",
          "upstream_stream_missing",
          "The Orbital gateway's provider returned no stream to relay.",
        ),
      ),
    );
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  const scanner = new StreamScanner();
  let interrupted: Failure | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      scanner.push(decoder.decode(value, { stream: true }), value.byteLength);
      // The bytes, in order, unparsed and unchanged — including the terminating `data: [DONE]`,
      // which is the frame the client is waiting for. A slow client is honoured rather than
      // outrun: waiting for `drain` is what stops a fast upstream from becoming this instance's
      // memory problem.
      if (!res.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength))) {
        await once(res, "drain");
      }
    }
  } catch (error) {
    if (!state.clientGone) {
      const reason = error instanceof Error ? error.name : "network failure";
      interrupted = failure(
        502,
        "upstream_error",
        "upstream_stream_interrupted",
        `The Orbital gateway's provider stopped mid-stream (${reason}). Retry.`,
      );
    }
  }

  if (!state.clientGone) {
    // Flush whatever part of a multi-byte character the last chunk ended on.
    scanner.push(decoder.decode(), 0);
    if (interrupted === null) {
      const scan = scanner.finish();
      await recordUsage(
        uid,
        model,
        scan.usage ?? estimateUsage(promptChars(body), scan.completionChars),
        credits,
      );
    } else {
      // The status was sent long ago and cannot be revised, so an error frame is the only thing the
      // client can still act on; a silent truncation would look like a network failure at its end.
      res.write(sseErrorFrame(interrupted));
    }
  }
  // A stream the caller abandoned records nothing: they received no completion, and a partial figure
  // written as if it were a finished one would be accounting that lies in the other direction.
  res.end();
}

/** Express 4 does not forward a rejected promise, so every async route is wrapped once, here. */
function handle(
  route: (req: Request, res: ExpressResponse) => Promise<void>,
): (req: Request, res: ExpressResponse, next: NextFunction) => void {
  return (req, res, next) => {
    route(req, res).catch(next);
  };
}

export function createApp(): Express {
  const app = express();
  // A generated validator would be a claim about a representation this process does not own: the
  // body it sends belongs to the upstream, byte for byte.
  app.set("etag", false);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "4mb" }));

  // Unauthenticated on purpose: a liveness probe that needs a credential cannot be used by the thing
  // whose job is to notice that the gateway is down.
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", version: VERSION });
  });

  // Authenticated but not entitlement-checked: the catalogue is not an allowance, and this is also
  // the call the settings page uses to answer "is this endpoint reachable with this sign-in", which
  // has to keep answering for an account that is merely out of tokens or credits. Reading the plan
  // is all it needs — and reading it is also what applies the lazy monthly reset, so the list a
  // caller sees is the one their next request will be checked against.
  app.get(
    "/v1/models",
    handle(async (req, res) => {
      const uid = await requireCaller(req);
      const account = await readAccount(uid);
      res.status(200).json({
        object: "list",
        data: catalogueFor(account.plan).map((entry) => ({
          id: entry.id,
          object: "model",
          owned_by: entry.ownedBy,
          credits_per_prompt: entry.creditsPerPrompt,
        })),
      });
    }),
  );

  // What the caller has left, in the same numbers a request would be checked against: the reset is
  // applied first, so `used` and `resets_at` describe the period that is actually running.
  app.get(
    "/v1/account",
    handle(async (req, res) => {
      const uid = await requireCaller(req);
      const account = await readAccount(uid);
      res.status(200).json({
        plan: account.plan,
        credits: {
          limit: account.creditsLimit,
          used: account.creditsUsed,
          remaining: creditsRemaining(account),
          resets_at: account.creditsResetAt.toISOString(),
        },
      });
    }),
  );

  app.post("/v1/chat/completions", handle(chatCompletions));

  app.use((req, res) => {
    sendFailure(
      res,
      failure(
        404,
        "invalid_request_error",
        "unknown_endpoint",
        `The Orbital gateway has no route ${req.method} ${req.path}. It serves /v1/models, ` +
          "/v1/account, /v1/chat/completions and /health.",
      ),
    );
  });

  app.use((error: unknown, _req: Request, res: ExpressResponse, _next: NextFunction) => {
    if (res.headersSent) {
      // The stream owns the response now and its status cannot be revised; close it, so the caller
      // sees a stream that ended rather than one that hangs.
      res.end();
      return;
    }
    if (error instanceof GatewayError) {
      sendFailure(res, error.failure);
      return;
    }
    const kind = (error as { type?: unknown } | null)?.type;
    if (kind === "entity.too.large") {
      sendFailure(
        res,
        failure(
          413,
          "invalid_request_error",
          "body_too_large",
          "The request body is larger than the 4 MB this gateway accepts.",
        ),
      );
      return;
    }
    if (kind === "entity.parse.failed") {
      sendFailure(
        res,
        failure(400, "invalid_request_error", "invalid_json", "The request body is not valid JSON."),
      );
      return;
    }
    // A bug or a dependency failure. Named by class in the log, never by body: the body is somebody's
    // source code.
    console.error(
      "[orbital-gateway] unhandled request failure",
      error instanceof Error ? error.name : typeof error,
    );
    sendFailure(
      res,
      failure(
        500,
        "server_error",
        "internal",
        "The Orbital gateway failed to handle the request. Retry, and report it if it keeps happening.",
      ),
    );
  });

  return app;
}
