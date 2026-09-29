/**
 * Who is calling.
 *
 * The caller proves who they are with a Firebase ID token. That is the whole security model of
 * this gateway: no key ships in the desktop app, so the only thing the client can present is proof
 * of an account, and the key that pays for the run stays here.
 */

import { getAuth } from "firebase-admin/auth";
import type { Request } from "express";
import { adminApp } from "./admin";
import { failure, GatewayError } from "./errors";

/** The bearer token the caller presented, or null when the header is absent or not a bearer one. */
function bearerToken(req: Request): string | null {
  const header = req.get("authorization");
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token !== undefined && token.length > 0 ? token : null;
}

/**
 * The uid behind the request, or the refusal that says why it could not be established.
 *
 * The two failures stay distinct because the client shows this text to a person: a missing header
 * means the app never signed in, while a rejected token means the sign-in has to be repeated — and
 * the Admin SDK's own code is what says which, without saying whose.
 */
export async function requireCaller(req: Request): Promise<string> {
  const token = bearerToken(req);
  if (token === null) {
    throw new GatewayError(
      failure(
        401,
        "invalid_request_error",
        "unauthenticated",
        "The Orbital gateway needs the caller's Firebase ID token in an `Authorization: Bearer` " +
          "header. Sign in with an Orbital account and retry.",
      ),
    );
  }

  try {
    // `checkRevoked` on purpose: an ID token is valid for an hour, and an account that was
    // disabled in the meantime must not keep spending the Orbital key until it expires.
    const decoded = await getAuth(adminApp()).verifyIdToken(token, true);
    return decoded.uid;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const reason = typeof code === "string" && code.length > 0 ? code.slice(0, 64) : "unverifiable";
    throw new GatewayError(
      failure(
        401,
        "invalid_request_error",
        "invalid_token",
        `Orbital could not verify the sign-in token (${reason}). Sign in again and retry.`,
      ),
    );
  }
}
