/**
 * The deployed surface — the only file that knows this is a Firebase Function.
 *
 * Everything the gateway *does* lives in `app.ts` and its neighbours, which are plain Express, fetch
 * and the Admin SDK. That split is deliberate: the behaviour is testable over a real socket without
 * a functions runtime, and this file is small enough to check by reading.
 */

import { defineSecret } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { createApp } from "./app";
import { UPSTREAM_KEY_ENV } from "./environment";

/**
 * The region decides the deployed URL, and the client's base URL is derived from it:
 * `https://us-central1-<project>.cloudfunctions.net/orbital/v1`. Changing it here changes what every
 * client has to be configured with.
 */
export const REGION = "us-central1";

/**
 * The Orbital key, bound from Secret Manager at deploy time. The binding is what makes the runtime
 * inject the value into the instance's environment, which is where `upstreamKey()` reads it — the
 * same environment a `.env.local` fills in under the emulator and a test fills in directly. One path
 * for the key, in all three.
 */
const upstreamApiKey = defineSecret(UPSTREAM_KEY_ENV);

/**
 * The app is built once per instance, not per request: it holds no per-request state, and rebuilding
 * it would re-register the same middleware on every call. `timeoutSeconds` is generous because a long
 * agent turn streams for minutes; the caller's own client timeout is the one that normally wins.
 */
export const orbital = onRequest(
  { region: REGION, timeoutSeconds: 300, secrets: [upstreamApiKey] },
  createApp(),
);
