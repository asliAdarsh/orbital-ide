/**
 * The Admin SDK application, created once per instance.
 *
 * Credentials are deliberately not passed in. In production the functions runtime provides
 * application default credentials; against the emulator suite no credentials are needed at all,
 * because `FIREBASE_AUTH_EMULATOR_HOST` and `FIRESTORE_EMULATOR_HOST` redirect both SDKs. Only the
 * project id has to be named, and it comes from the environment the runtime and the emulator both
 * set — which is what lets the same code run in production, in the emulator and in a test.
 */

import { getApps, initializeApp, type App } from "firebase-admin/app";

export function adminApp(): App {
  const existing = getApps()[0];
  if (existing !== undefined) return existing;
  const projectId =
    process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;
  return projectId === undefined ? initializeApp() : initializeApp({ projectId });
}
