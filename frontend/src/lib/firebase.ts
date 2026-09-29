/**
 * The Firebase client, and the single place the app decides whether it has a config at all.
 *
 * The values are Vite env vars, so a checkout with no `frontend/.env.local` has none of them.
 * In that case nothing here touches `initializeApp`: `firebaseConfigError` carries the sentence
 * the login page shows instead, because a half-initialised app fails later, in a worse place —
 * and an import that threw would blank the window before React could render anything.
 *
 * These identifiers are public client config, not secrets: they name the project to Firebase
 * from the browser and are safe in the bundle.
 */

import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";

/** Read through the object, not per-key: `import.meta.env` is replaced wholesale at build time. */
const env = import.meta.env;

/** The identifiers an Auth instance cannot be built without. The bucket and sender id are optional. */
const REQUIRED_KEYS = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_APP_ID",
] as const;

function read(key: string): string {
  const value: unknown = env[key];
  return typeof value === "string" ? value.trim() : "";
}

/** `a, b and c` — an error message that ends in a comma-comma list reads as truncated. */
function listAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const missingKeys = REQUIRED_KEYS.filter((key) => read(key) === "");

/**
 * Null when the client is usable, otherwise the sentence the login page renders in place of the
 * form. It names the variables that are absent — "Firebase is misconfigured" sends the reader
 * hunting through six files — and says what to do about it.
 */
export const firebaseConfigError: string | null =
  missingKeys.length === 0
    ? null
    : `Missing ${listAnd(missingKeys)}. Copy frontend/.env.example to frontend/.env.local, fill in the values from the Firebase console, then restart the dev server.`;

/**
 * True when the app was pointed at the local emulator suite. The login page says so: an account
 * created against the emulator is not a real one, and nothing else in the UI would reveal that.
 */
export const usingAuthEmulator = read("VITE_FIREBASE_EMULATOR") === "1";

function createAuth(): Auth {
  const app = initializeApp({
    apiKey: read("VITE_FIREBASE_API_KEY"),
    authDomain: read("VITE_FIREBASE_AUTH_DOMAIN"),
    projectId: read("VITE_FIREBASE_PROJECT_ID"),
    appId: read("VITE_FIREBASE_APP_ID"),
    // Omitted rather than empty: an empty string is not a value Firebase should try to parse.
    storageBucket: read("VITE_FIREBASE_STORAGE_BUCKET") || undefined,
    messagingSenderId: read("VITE_FIREBASE_MESSAGING_SENDER_ID") || undefined,
  });
  const instance = getAuth(app);
  if (usingAuthEmulator) {
    // The "you are using the emulator" console banner is noise here: the page itself says so,
    // to the person who needs to know.
    connectAuthEmulator(instance, "http://127.0.0.1:9099", { disableWarnings: true });
  }
  return instance;
}

/**
 * The Auth instance, or null when {@link firebaseConfigError} explains why there is none. Callers
 * that reach for it before checking that are the bug this module exists to prevent.
 */
export const auth: Auth | null = firebaseConfigError === null ? createAuth() : null;
