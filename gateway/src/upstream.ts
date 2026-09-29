/**
 * Talking to the provider that actually holds the key.
 *
 * Two rules shape this module. The Orbital key goes here and nowhere else — not to the client, not
 * into a log line, not into an error body — and the caller's request crosses over unchanged except
 * for the model the catalogue resolved. The second rule is why the upstream's own error text is
 * quoted only after the key has been taken out of it: an upstream that answers a rejected credential
 * by echoing it would otherwise leak the key back to the caller through this gateway.
 */

import { MAX_DETAIL_CHARS, MAX_ERROR_BODY_CHARS, upstreamBaseUrl, upstreamKey, VERSION } from "./config";
import { UPSTREAM_KEY_ENV } from "./environment";
import { failure, type Failure } from "./errors";
import { asRecord, parseJsonRecord } from "./values";

/** The client's conversation id. It is the one client header that survives the hop. */
export const SESSION_HEADER = "x-opencode-session";

/** The longest conversation id forwarded upstream. A header value is not a place for a novel. */
const SESSION_ID_MAX_CHARS = 128;

/** Anything outside this set has no business in an HTTP header value. */
function sanitizeSessionId(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, "");
}

/**
 * The value sent upstream as the conversation id: the caller's own when it has one, otherwise one
 * derived from the account.
 *
 * Always sent, never optional. The upstream this gateway fronts refuses a request without it, and
 * requiring it would make this endpoint unusable by any ordinary OpenAI-compatible client — the
 * desktop app only survived because its runtime happens to send it. A caller that sets its own gets
 * true per-conversation routing; a caller that does not shares one conversation per account, which
 * is the honest fallback rather than a fresh conversation on every request.
 *
 * A caller-supplied value is sanitized and bounded before it leaves, because it rides a request this
 * gateway signs with the Orbital key: a stranger's spaces, quotes, non-ASCII and unbounded length do
 * not belong in that header.
 */
export function upstreamSessionId(callerId: string | null, uid: string): string {
  const accountId = `orbital-${sanitizeSessionId(uid)}`;
  const candidate = callerId === null ? "" : sanitizeSessionId(callerId);
  return candidate.length === 0 ? accountId : candidate.slice(0, SESSION_ID_MAX_CHARS);
}

export interface UpstreamCall {
  /** The caller's body, with `model` replaced by the catalogue's upstream name. */
  readonly body: Record<string, unknown>;
  readonly sessionId: string | null;
  /** The authenticated account, which names the conversation when the caller sends no id. */
  readonly uid: string;
  /** Aborted when the caller disappears, so a client that gave up stops costing tokens. */
  readonly signal: AbortSignal;
}

export async function callUpstream(call: UpstreamCall): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${upstreamKey()}`,
    "user-agent": `orbital-gateway/${VERSION}`,
  };
  // The conversation id crosses over because the upstream uses it for routing and prompt-cache
  // reuse and the client sets it for exactly that reason. Nothing else of the client's does — least
  // of all its Authorization header, which is an account token and not a provider credential.
  headers[SESSION_HEADER] = upstreamSessionId(call.sessionId, call.uid);
  return fetch(`${upstreamBaseUrl()}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(call.body),
    signal: call.signal,
  });
}

function redactKey(text: string): string {
  const key = process.env[UPSTREAM_KEY_ENV]?.trim();
  return key === undefined || key.length === 0 ? text : text.split(key).join("[redacted]");
}

/**
 * The upstream's own words about a refusal, made safe to pass on: the key removed, flattened to one
 * line (a refusal message ends up in a JSON body and a UI), and bounded (an upstream error page is
 * not a sentence).
 */
export function upstreamDetail(bodyText: string): string {
  const body = bodyText.slice(0, MAX_ERROR_BODY_CHARS);
  const parsed = parseJsonRecord(body);
  let message = parsed === null ? body : "";
  if (parsed !== null) {
    const nested = asRecord(parsed.error);
    const candidates = [
      nested?.message,
      typeof parsed.error === "string" ? parsed.error : undefined,
      parsed.detail,
      parsed.message,
    ];
    const found = candidates.find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0,
    );
    if (found !== undefined) message = found;
  }
  return redactKey(message).replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL_CHARS);
}

/**
 * The upstream's refusal, re-aimed at the caller it actually concerns.
 *
 * The status is not copied blindly. A 401 or 403 from the upstream is about *this gateway's*
 * credential, and forwarding it would make the client tell the user to re-enter an API key they
 * never entered — so it becomes a 502 that says whose problem it is. A 429 or a 5xx likewise
 * becomes something the client will retry rather than something it will blame a key for. A 4xx the
 * upstream aimed at the request itself keeps its status, because the caller can act on it.
 */
export function upstreamFailure(status: number, bodyText: string): Failure {
  const detail = upstreamDetail(bodyText);
  const said = detail.length === 0 ? "" : ` It said: ${detail}`;
  if (status === 401 || status === 403) {
    return failure(
      502,
      "upstream_error",
      "upstream_credential_refused",
      `The Orbital gateway's provider rejected the gateway's own credential (HTTP ${status}). ` +
        `This is the gateway's problem, not yours; retry shortly.${said}`,
    );
  }
  if (status === 429) {
    return failure(
      429,
      "rate_limit_error",
      "upstream_rate_limited",
      `The Orbital gateway's provider is rate limiting it (HTTP 429). Retry shortly.${said}`,
    );
  }
  if (status >= 500) {
    return failure(
      502,
      "upstream_error",
      "upstream_failed",
      `The Orbital gateway's provider failed (HTTP ${status}). This is the gateway's problem, not ` +
        `yours; retry shortly.${said}`,
    );
  }
  return failure(
    status,
    "invalid_request_error",
    "upstream_rejected_request",
    `The Orbital gateway's provider refused the request (HTTP ${status}).${said}`,
  );
}
