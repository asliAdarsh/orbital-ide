/**
 * The error envelope — and why it has this exact shape.
 *
 * The desktop client reads `error.message` out of a refusal body and shows it in a chat bubble
 * and in Settings. So every refusal this gateway emits is OpenAI-shaped: an HTTP status plus
 * `{ error: { message, type, code } }`. `message` is the field the client depends on; `type` and
 * `code` exist because that is what the shape means to anything else that speaks OpenAI, and
 * because they are what a log line or a support question can be answered with.
 *
 * Nothing here ever carries an upstream key, an ID token, a prompt or a completion: this module is
 * the one place refusal text is built, so it is the one place to check that claim.
 */

import type { Response } from "express";

export type ErrorType =
  | "invalid_request_error"
  | "insufficient_quota"
  | "insufficient_credits"
  | "permission_denied"
  | "rate_limit_error"
  | "upstream_error"
  | "server_error";

export interface Failure {
  readonly status: number;
  readonly type: ErrorType;
  readonly code: string;
  readonly message: string;
}

/**
 * A refusal message is headed for a client's UI, a log line and possibly a support ticket, so it
 * is normalised here rather than trusted: one line, no control characters, bounded. A message
 * assembled around an upstream's own words can otherwise arrive with newlines and kilobytes.
 */
export const MAX_MESSAGE_CHARS = 400;

export function failure(status: number, type: ErrorType, code: string, message: string): Failure {
  const flat = message.replace(/\s+/g, " ").trim();
  return {
    status,
    type,
    code,
    message: flat.length > MAX_MESSAGE_CHARS ? `${flat.slice(0, MAX_MESSAGE_CHARS - 1)}…` : flat,
  };
}

/** Thrown by any layer that has decided how the caller should be refused. */
export class GatewayError extends Error {
  readonly failure: Failure;

  constructor(failureValue: Failure) {
    super(failureValue.message);
    this.name = "GatewayError";
    this.failure = failureValue;
  }
}

/** The only place a refusal becomes bytes, so the envelope cannot drift between routes. */
export function sendFailure(res: Response, failureValue: Failure): void {
  res.status(failureValue.status).json({
    error: {
      message: failureValue.message,
      type: failureValue.type,
      code: failureValue.code,
    },
  });
}
