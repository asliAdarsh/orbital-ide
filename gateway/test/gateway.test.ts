/**
 * What the gateway does, over a real socket, against the emulator suite and a stub upstream.
 *
 * Each test creates the accounts it needs, so nothing here depends on the order the runner picks or
 * on what a previous run left in the emulator.
 */

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { ServerResponse } from "node:http";
import { before, describe, it } from "node:test";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import packageJson from "../package.json";
import { adminApp } from "../src/admin";
import { CATALOGUE, MAX_IN_FLIGHT_PER_ACCOUNT, MAX_TOKENS_CLAMP, VERSION } from "../src/config";
import { UPSTREAM_BASE_URL_ENV } from "../src/environment";
import { SESSION_HEADER } from "../src/upstream";
import { jsonLength } from "../src/values";
import {
  assertEmulatorSuiteIsRunning,
  configureEmulators,
  createUser,
  sendJson,
  startGateway,
  startStubUpstream,
  UPSTREAM_KEY,
  type GatewayHandle,
  type StubHandler,
  type StubUpstream,
  type TestUser,
} from "./support";

configureEmulators();

before(async () => {
  await assertEmulatorSuiteIsRunning();
});

/** A completion body of the shape the desktop client sends, tool definitions included. */
function clientBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "deepseek-v4-flash",
    messages: [
      { role: "system", content: "You are Orbital." },
      { role: "user", content: "Write the phase plan for the provider profiles work." },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "write_file",
          description: "Write a file into the workspace",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ],
    tool_choice: "auto",
    temperature: 0.2,
    max_tokens: 512,
    ...overrides,
  };
}

/** A completed completion, with or without the usage an upstream may report. */
function completion(content: string, usage: Record<string, number> | null): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "deepseek-v4-flash",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    ...(usage === null ? {} : { usage }),
  };
}

interface ErrorEnvelope {
  readonly error: { readonly message: string; readonly type: string; readonly code: string };
}

async function errorOf(response: Response): Promise<ErrorEnvelope["error"]> {
  const body = (await response.json()) as Partial<ErrorEnvelope>;
  return {
    message: body.error?.message ?? "",
    type: body.error?.type ?? "",
    code: body.error?.code ?? "",
  };
}

/**
 * A gateway pointed at a stub upstream, torn down whatever the test does with it. Every test that
 * reaches a provider goes through here, so no test can accidentally talk to the real one.
 */
async function withStubUpstream(
  handler: StubHandler,
  body: (stub: StubUpstream, gateway: GatewayHandle) => Promise<void>,
): Promise<void> {
  const stub = await startStubUpstream(handler);
  process.env[UPSTREAM_BASE_URL_ENV] = stub.baseUrl;
  const gateway = await startGateway();
  try {
    await body(stub, gateway);
  } finally {
    await gateway.close();
    await stub.close();
    delete process.env[UPSTREAM_BASE_URL_ENV];
  }
}

/** Answers every completion with one JSON body and a usage figure. */
function answerWith(content: string, usage: Record<string, number> | null): StubHandler {
  return (_body, response) => {
    sendJson(response, 200, completion(content, usage));
  };
}

function accountDocument(uid: string) {
  return getFirestore(adminApp()).doc(`users/${uid}`);
}

async function setAccount(uid: string, data: Record<string, unknown>): Promise<void> {
  await accountDocument(uid).set(data);
}

async function usageRecords(uid: string): Promise<Record<string, unknown>[]> {
  const snapshot = await getFirestore(adminApp()).collection(`users/${uid}/usage`).get();
  return snapshot.docs.map((doc) => doc.data());
}

/**
 * Wait for the accounting write, which deliberately runs after the response has been handed over.
 * A document listener is the signal — an event, not a guessed delay — and the snapshot that arrives
 * on subscribing is what makes a write that already landed impossible to miss.
 */
async function waitForAccount(
  uid: string,
  matches: (data: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const settled = new EventEmitter();
  const arrived = once(settled, "account-settled");
  const unsubscribe = accountDocument(uid).onSnapshot(
    (snapshot) => {
      const data = snapshot.data() ?? {};
      if (matches(data)) settled.emit("account-settled", data);
    },
    (error: unknown) => settled.emit("error", error),
  );
  try {
    const [data] = (await arrived) as [Record<string, unknown>];
    return data;
  } finally {
    unsubscribe();
  }
}

function postCompletion(
  gateway: GatewayHandle,
  user: TestUser,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${gateway.origin}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${user.idToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A hang in a test that waits on the emulator should read as a failure, not as a stuck run. */
const WAITING_TEST = { timeout: 30_000 };

describe("the Orbital gateway", () => {
  it("answers /health without a credential, with the version this build ships", async () => {
    const gateway = await startGateway();
    try {
      const response = await fetch(`${gateway.origin}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ok", version: VERSION });
      // The deployed gateway has to be able to say which build it is.
      assert.equal(VERSION, packageJson.version);
    } finally {
      await gateway.close();
    }
  });

  it("refuses /v1/models without a verified token, in the shape the client reads", async () => {
    const gateway = await startGateway();
    try {
      const anonymous = await fetch(`${gateway.origin}/v1/models`);
      assert.equal(anonymous.status, 401);
      const missing = await errorOf(anonymous);
      assert.equal(missing.type, "invalid_request_error");
      assert.match(missing.message, /Authorization/);

      const forged = await fetch(`${gateway.origin}/v1/models`, {
        headers: { authorization: "Bearer not-a-real-token" },
      });
      assert.equal(forged.status, 401);
      assert.equal((await errorOf(forged)).code, "invalid_token");
    } finally {
      await gateway.close();
    }
  });

  it("lists the catalogue in OpenAI's shape, with a cost per model, for a signed-in caller", async () => {
    const user = await createUser();
    const gateway = await startGateway();
    try {
      const response = await fetch(`${gateway.origin}/v1/models`, {
        headers: { authorization: `Bearer ${user.idToken}` },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { object: string; data: Record<string, unknown>[] };
      assert.equal(body.object, "list");
      assert.equal(body.data.length, CATALOGUE.length);
      for (const entry of body.data) {
        assert.equal(entry.object, "model");
        assert.equal(entry.owned_by, "orbital");
        // The tier is the whole credit model, so every entry has to carry one and nothing may
        // carry a fourth value that the charging code would not know how to add up.
        assert.ok(
          entry.credits_per_prompt === 0.5 || entry.credits_per_prompt === 1 || entry.credits_per_prompt === 2,
          `${String(entry.id)} carries a credit cost from the three tiers`,
        );
      }
      // The exact id-to-cost table is asserted in credits.test.ts; here the shape and the coverage.
      assert.deepEqual(
        body.data.map((entry) => entry.id),
        CATALOGUE.map((entry) => entry.id),
      );
    } finally {
      await gateway.close();
    }
  });

  it("refuses a token issued for an account that has since been disabled", async () => {
    const user = await createUser();
    // The token stays cryptographically valid for an hour; only a revocation check notices this.
    await getAuth(adminApp()).updateUser(user.uid, { disabled: true });
    const gateway = await startGateway();
    try {
      const response = await fetch(`${gateway.origin}/v1/models`, {
        headers: { authorization: `Bearer ${user.idToken}` },
      });
      assert.equal(response.status, 401);
      assert.match((await errorOf(response)).message, /auth\/user-disabled/);
    } finally {
      await gateway.close();
    }
  });

  it("refuses an unauthenticated completion before the provider hears about it", async () => {
    await withStubUpstream(answerWith("never sent", null), async (stub, gateway) => {
      const response = await fetch(`${gateway.origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(clientBody()),
      });
      assert.equal(response.status, 401);
      assert.equal((await errorOf(response)).code, "unauthenticated");
      assert.equal(stub.calls.length, 0);
    });
  });

  it("refuses a suspended account, and does not spend the Orbital key on it", async () => {
    const user = await createUser();
    await setAccount(user.uid, { disabled: true, tokensUsed: 0, tokensLimit: 1000 });
    await withStubUpstream(answerWith("never sent", null), async (stub, gateway) => {
      const response = await postCompletion(gateway, user, clientBody());
      assert.equal(response.status, 403);
      const refusal = await errorOf(response);
      assert.equal(refusal.code, "account_suspended");
      assert.match(refusal.message, /suspended/i);
      assert.equal(stub.calls.length, 0);
    });
  });

  it("refuses an account whose allowance is used up, and says when it resets", async () => {
    const spent = await createUser();
    const over = await createUser();
    await setAccount(spent.uid, { plan: "free", tokensUsed: 1000, tokensLimit: 1000 });
    await setAccount(over.uid, { plan: "free", tokensUsed: 1500, tokensLimit: 1000 });
    await withStubUpstream(answerWith("never sent", null), async (stub, gateway) => {
      for (const user of [spent, over]) {
        const response = await postCompletion(gateway, user, clientBody());
        assert.equal(response.status, 402);
        const refusal = await errorOf(response);
        assert.equal(refusal.code, "allowance_exhausted");
        assert.match(refusal.message, /used up/);
        assert.match(refusal.message, /resets at \d{4}-\d{2}-01T00:00:00\.000Z/);
      }
      assert.equal(stub.calls.length, 0);
    });
  });

  it(
    "serves an account with no document at all, unchanged except the model, and records the cost",
    WAITING_TEST,
    async () => {
      const user = await createUser();
      const usage = { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 };
      const sent = clientBody({ stream: false });
      await withStubUpstream(answerWith("the plan", usage), async (stub, gateway) => {
        const response = await postCompletion(gateway, user, sent);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "application/json");
        assert.deepEqual(JSON.parse(await response.text()), completion("the plan", usage));

        // Everything the client sent crossed over intact: the tools, the choice, the sampling
        // parameters, the multi-turn array — and the model the catalogue resolved.
        assert.equal(stub.calls.length, 1);
        assert.deepEqual(stub.calls[0]?.body, sent);

        const account = await waitForAccount(user.uid, (data) => data.tokensUsed === 52);
        assert.equal(account.tokensUsed, 52);

        const records = await usageRecords(user.uid);
        assert.equal(records.length, 1);
        const record = records[0] ?? {};
        assert.equal(record.model, "deepseek-v4-flash");
        assert.equal(record.promptTokens, 40);
        assert.equal(record.completionTokens, 12);
        assert.equal(record.totalTokens, 52);
        assert.ok(record.at !== undefined && record.at !== null, "a usage record carries its time");
      });
    },
  );

  it("refuses a model outside the catalogue by name, without asking the provider", async () => {
    const user = await createUser();
    await withStubUpstream(answerWith("never sent", null), async (stub, gateway) => {
      const unknown = await postCompletion(gateway, user, clientBody({ model: "gpt-4o" }));
      assert.equal(unknown.status, 400);
      const refusal = await errorOf(unknown);
      assert.equal(refusal.code, "model_not_found");
      assert.match(refusal.message, /"gpt-4o"/);
      assert.match(refusal.message, /deepseek-v4-flash/);

      const missing = await postCompletion(gateway, user, clientBody({ model: undefined }));
      assert.equal(missing.status, 400);
      assert.equal((await errorOf(missing)).code, "model_required");
      assert.equal(stub.calls.length, 0);
    });
  });

  it("relays a streamed completion byte for byte, including the closing [DONE]", WAITING_TEST, async () => {
    const user = await createUser();
    const stream = [
      `data: ${JSON.stringify({ id: "chatcmpl-test", choices: [{ index: 0, delta: { role: "assistant", content: "café" } }] })}\n\n`,
      `data: ${JSON.stringify({ id: "chatcmpl-test", choices: [{ index: 0, delta: { content: " 🛠️ plan" } }] })}\n\n`,
      `data: ${JSON.stringify({ id: "chatcmpl-test", choices: [], usage: { prompt_tokens: 31, completion_tokens: 9, total_tokens: 40 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const sent = clientBody({ stream: true });

    await withStubUpstream(
      (_body, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const bytes = Buffer.from(stream, "utf8");
        // Split deliberately in the middle of the emoji's bytes: where a chunk boundary lands is the
        // network's business, and the relay must not care. The second half goes out on the write
        // callback, so it is a second chunk by construction rather than by a guessed delay.
        const cut = bytes.indexOf(Buffer.from("🛠️")) + 2;
        response.write(bytes.subarray(0, cut), () => {
          response.end(bytes.subarray(cut));
        });
      },
      async (stub, gateway) => {
        const response = await postCompletion(gateway, user, sent);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "text/event-stream");
        const text = await response.text();
        assert.equal(text, stream);
        assert.ok(text.endsWith("data: [DONE]\n\n"), "the stream ends with the frame clients wait for");

        assert.deepEqual(stub.calls[0]?.body, sent);

        const account = await waitForAccount(user.uid, (data) => data.tokensUsed === 40);
        assert.equal(account.tokensUsed, 40, "the usage in the final frame is what gets recorded");
        const record = (await usageRecords(user.uid))[0] ?? {};
        assert.equal(record.totalTokens, 40);
      },
    );
  });

  it("estimates the usage an upstream did not report, from what it did send", WAITING_TEST, async () => {
    const user = await createUser();
    const deltas = ["one ", "two"];
    const stream = [
      ...deltas.map(
        (content) =>
          `data: ${JSON.stringify({ id: "chatcmpl-test", choices: [{ index: 0, delta: { content } }] })}\n\n`,
      ),
      "data: [DONE]\n\n",
    ].join("");
    const sent = clientBody({ stream: true });

    await withStubUpstream(
      (_body, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(Buffer.from(stream, "utf8"));
      },
      async (stub, gateway) => {
        const response = await postCompletion(gateway, user, sent);
        assert.equal(await response.text(), stream);
        assert.equal(stub.calls.length, 1);

        // Four characters per token, over the request's prompt and the text that came back: "one two"
        // is seven characters, so two tokens.
        const promptChars = jsonLength(sent.messages) + jsonLength(sent.tools);
        const expected = Math.ceil(promptChars / 4) + 2;
        const account = await waitForAccount(user.uid, (data) => data.tokensUsed === expected);
        assert.equal(account.tokensUsed, expected);

        const record = (await usageRecords(user.uid))[0] ?? {};
        assert.equal(record.completionTokens, 2);
        assert.equal(record.totalTokens, expected);
      },
    );
  });

  it("clamps max_tokens to the gateway's ceiling, and says so", async () => {
    const user = await createUser();
    await withStubUpstream(
      answerWith("ok", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      async (stub, gateway) => {
        const clamped = await postCompletion(gateway, user, clientBody({ max_tokens: 100_000 }));
        assert.equal(clamped.status, 200);
        assert.equal(clamped.headers.get("x-orbital-clamped-max-tokens"), String(MAX_TOKENS_CLAMP));
        await clamped.text();
        assert.equal(stub.calls[0]?.body.max_tokens, MAX_TOKENS_CLAMP);

        const untouched = await postCompletion(gateway, user, clientBody({ max_tokens: 100 }));
        assert.equal(untouched.headers.get("x-orbital-clamped-max-tokens"), null);
        await untouched.text();
        assert.equal(stub.calls[1]?.body.max_tokens, 100);
      },
    );
  });

  it("authenticates the hop with the gateway's key, forwards the conversation id, and leaks neither", async () => {
    const user = await createUser();
    await withStubUpstream(
      answerWith("ok", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      async (stub, gateway) => {
        const response = await fetch(`${gateway.origin}/v1/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${user.idToken}`,
            "content-type": "application/json",
            "x-opencode-session": "session-42",
          },
          body: JSON.stringify(clientBody()),
        });
        const text = await response.text();
        assert.equal(stub.calls[0]?.headers.authorization, `Bearer ${UPSTREAM_KEY}`);
        assert.notEqual(stub.calls[0]?.headers.authorization, `Bearer ${user.idToken}`);
        assert.equal(stub.calls[0]?.headers["x-opencode-session"], "session-42");
        assert.equal(text.includes(UPSTREAM_KEY), false);
        assert.equal(text.includes(user.idToken), false);
      },
    );
  });

  it("supplies a conversation id when the caller sends none, stable per account", async () => {
    const first = await createUser();
    const second = await createUser();
    await withStubUpstream(
      answerWith("ok", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      async (stub, gateway) => {
        const send = (token: string, session?: string) =>
          fetch(`${gateway.origin}/v1/chat/completions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              ...(session === undefined ? {} : { [SESSION_HEADER]: session }),
            },
            body: JSON.stringify(clientBody()),
          });

        assert.equal((await send(first.idToken)).status, 200);
        assert.equal((await send(first.idToken)).status, 200);
        assert.equal((await send(second.idToken)).status, 200);

        const generated = stub.calls[0]?.headers[SESSION_HEADER];
        assert.ok(
          typeof generated === "string" && generated.length > 0,
          "the upstream always needs a conversation id, whether or not the caller sent one",
        );
        assert.equal(stub.calls[1]?.headers[SESSION_HEADER], generated, "stable for the same account");
        assert.notEqual(stub.calls[2]?.headers[SESSION_HEADER], generated, "not shared between accounts");
      },
    );
  });

  it("sanitizes and bounds a caller-supplied conversation id before forwarding it", async () => {
    const user = await createUser();
    await withStubUpstream(
      answerWith("ok", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      async (stub, gateway) => {
        const messy = `has spaces "quotes" and ünïcode ${"x".repeat(400)}`;
        const response = await fetch(`${gateway.origin}/v1/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${user.idToken}`,
            "content-type": "application/json",
            [SESSION_HEADER]: messy,
          },
          body: JSON.stringify(clientBody()),
        });

        assert.equal(response.status, 200);
        const forwarded = stub.calls[0]?.headers[SESSION_HEADER];
        assert.equal(typeof forwarded, "string");
        if (typeof forwarded !== "string") return;
        assert.match(forwarded, /^[A-Za-z0-9._:-]+$/);
        assert.ok(forwarded.length <= 128, `expected a bounded id, got ${forwarded.length} characters`);
      },
    );
  });

  it("keeps the key out of an upstream failure, and never blames the caller's credential for it", async () => {
    const user = await createUser();
    await withStubUpstream(
      (_body, response) => {
        sendJson(response, 500, {
          error: { message: `boom with ${UPSTREAM_KEY} inside`, type: "server_error" },
        });
      },
      async (_stub, gateway) => {
        const failed = await postCompletion(gateway, user, clientBody());
        assert.equal(failed.status, 502);
        const failure = await errorOf(failed);
        assert.equal(failure.code, "upstream_failed");
        assert.match(failure.message, /\[redacted\]/);
        assert.equal(failure.message.includes(UPSTREAM_KEY), false);
      },
    );

    await withStubUpstream(
      (_body, response) => {
        sendJson(response, 401, { error: { message: "invalid api key" } });
      },
      async (_stub, gateway) => {
        // The client reads 401/403 as "the key you configured is bad"; the gateway's own upstream
        // credential being refused is not that, and must not be reported as it.
        const refused = await postCompletion(gateway, user, clientBody());
        assert.equal(refused.status, 502);
        assert.equal((await errorOf(refused)).code, "upstream_credential_refused");
      },
    );
  });

  it("caps how many requests one account may have open on an instance", async () => {
    const user = await createUser();
    const held: ServerResponse[] = [];
    await withStubUpstream(
      (_body, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        held.push(response);
      },
      async (stub, gateway) => {
        const open = Array.from({ length: MAX_IN_FLIGHT_PER_ACCOUNT }, () =>
          postCompletion(gateway, user, clientBody({ stream: true })),
        );
        await stub.waitForCalls(MAX_IN_FLIGHT_PER_ACCOUNT);
        assert.equal(held.length, MAX_IN_FLIGHT_PER_ACCOUNT);

        const extra = await postCompletion(gateway, user, clientBody({ stream: true }));
        assert.equal(extra.status, 429);
        assert.equal((await errorOf(extra)).code, "too_many_concurrent_requests");
        assert.equal(stub.calls.length, MAX_IN_FLIGHT_PER_ACCOUNT, "the capped request never left");

        for (const response of held) response.end("data: [DONE]\n\n");
        await Promise.all((await Promise.all(open)).map((response) => response.text()));
      },
    );
  });

  it("answers an unknown route in the same error shape as everything else", async () => {
    const gateway = await startGateway();
    try {
      const response = await fetch(`${gateway.origin}/v1/embeddings`, { method: "POST" });
      assert.equal(response.status, 404);
      assert.equal((await errorOf(response)).code, "unknown_endpoint");
    } finally {
      await gateway.close();
    }
  });
});
