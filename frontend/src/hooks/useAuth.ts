/**
 * Firebase Auth state for the React tree.
 *
 * Each caller gets its own listener — the gate in `App`, the form on the login page and the
 * account row in the profile popover each own their busy/error state. That is cheap, and it
 * keeps this hook usable without a provider or a second store, which is where the app's
 * server state lives.
 *
 * `status` starts at `"loading"` deliberately: Firebase resolves the persisted session
 * asynchronously, and a `"signed-out"` first paint would flash the login page at someone who
 * is already signed in.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { FirebaseError } from "firebase/app";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as endFirebaseSession,
  type Auth,
  type User,
} from "firebase/auth";

import { auth, firebaseConfigError } from "@/lib/firebase";

export type AuthStatus = "loading" | "signed-out" | "signed-in";

export interface AuthApi {
  status: AuthStatus;
  user: User | null;
  /** The sentence for the last failed action; null when there is nothing to report. */
  error: string | null;
  /** True while an action is in flight — the form disables itself on this. */
  busy: boolean;
  /**
   * Resolve `false` only when the action failed, with `error` saying why. Signing in
   * successfully moves {@link AuthApi.status} instead of returning a value.
   */
  signIn(email: string, password: string): Promise<boolean>;
  signUp(email: string, password: string): Promise<boolean>;
  signInWithGoogle(): Promise<boolean>;
  signOut(): Promise<boolean>;
  /**
   * Resolves `true` once a reset has been asked for — including for an address with no account,
   * because the alternative tells whoever is typing which addresses Orbital knows.
   */
  resetPassword(email: string): Promise<boolean>;
  clearError(): void;
}

/**
 * Firebase's codes as sentences.
 *
 * The codes that mean "no such account" and "wrong password" share one wording on purpose: a
 * more precise message lets anyone probe which addresses have accounts, and the person typing
 * gets the same fix either way.
 */
const MESSAGES: Record<string, string> = {
  "auth/invalid-credential": "Wrong email or password.",
  "auth/wrong-password": "Wrong email or password.",
  "auth/user-not-found": "Wrong email or password.",
  "auth/invalid-email": "That email address does not look right.",
  "auth/email-already-in-use": "That email already has an account — sign in instead.",
  "auth/weak-password": "Use at least 8 characters.",
  "auth/too-many-requests": "Too many attempts — wait a minute and try again.",
  "auth/network-request-failed": "Could not reach Firebase — check your connection and try again.",
  "auth/operation-not-allowed": "That sign-in method is not enabled for this Firebase project.",
  "auth/account-exists-with-different-credential":
    "That email already has an account with a different sign-in method.",
  "auth/popup-blocked": "The browser blocked the Google window — allow pop-ups and try again.",
  "auth/unauthorized-domain": "This domain is not authorised for sign-in in the Firebase project.",
};

/** A closed popup is the user changing their mind, not a failure: no message at all. */
const SILENT_CODES: Record<string, true> = {
  "auth/popup-closed-by-user": true,
  "auth/cancelled-popup-request": true,
};

/**
 * One line for the error slot, or null when the code is one of the user's own cancellations.
 *
 * The unmapped fallback names the code: it is the only place that string can surface, and a
 * bug report that says `auth/argument-error` is worth ten that say "something went wrong".
 */
function messageFor(cause: unknown): string | null {
  if (!(cause instanceof FirebaseError)) return "Something went wrong. Try again.";
  if (SILENT_CODES[cause.code] === true) return null;
  return MESSAGES[cause.code] ?? `Something went wrong (${cause.code}). Try again.`;
}

export function useAuth(): AuthApi {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Signing in unmounts the login page mid-await, so a late setState must be dropped rather
  // than written into a tree that is gone.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (auth === null) {
      // No config: there is no session to restore, so this must not stay "loading" forever —
      // the gate would sit on the session screen and the config message would never appear.
      setStatus("signed-out");
      setUser(null);
      return;
    }
    return onAuthStateChanged(
      auth,
      (next) => {
        setUser(next);
        setStatus(next === null ? "signed-out" : "signed-in");
      },
      (cause: unknown) => {
        // A listener failure is not a signed-out state — say so instead of guessing.
        setError(messageFor(cause) ?? "Could not read the sign-in state.");
      },
    );
  }, []);

  /**
   * The shared body of every action: one busy flag, one error slot, one place that knows how to
   * translate a Firebase failure. `instance` is non-null inside `action` because the guard above
   * has already returned.
   */
  const attempt = useCallback(async (action: (instance: Auth) => Promise<unknown>): Promise<boolean> => {
    if (auth === null) {
      setError(firebaseConfigError ?? "Firebase Auth is not available in this build.");
      return false;
    }
    setBusy(true);
    try {
      await action(auth);
      if (live.current) setError(null);
      return true;
    } catch (cause: unknown) {
      if (live.current) setError(messageFor(cause));
      return false;
    } finally {
      if (live.current) setBusy(false);
    }
  }, []);

  const signIn = useCallback(
    (email: string, password: string) =>
      attempt((instance) => signInWithEmailAndPassword(instance, email, password)),
    [attempt],
  );

  const signUp = useCallback(
    (email: string, password: string) =>
      attempt((instance) => createUserWithEmailAndPassword(instance, email, password)),
    [attempt],
  );

  const signInWithGoogle = useCallback(
    (): Promise<boolean> =>
      attempt((instance) =>
        // The account picker every time: a one-click Google sign-in that silently reuses the
        // last account is how people end up in someone else's workspace on a shared machine.
        signInWithPopup(instance, new GoogleAuthProvider()),
      ),
    [attempt],
  );

  const signOut = useCallback((): Promise<boolean> => attempt((instance) => endFirebaseSession(instance)), [attempt]);

  const resetPassword = useCallback(async (email: string): Promise<boolean> => {
    if (auth === null) {
      setError(firebaseConfigError ?? "Firebase Auth is not available in this build.");
      return false;
    }
    setBusy(true);
    try {
      await sendPasswordResetEmail(auth, email);
      if (live.current) setError(null);
      return true;
    } catch (cause: unknown) {
      // An unknown address reports success too — see the doc comment on the API method.
      const code = cause instanceof FirebaseError ? cause.code : null;
      if (code === "auth/user-not-found") {
        if (live.current) setError(null);
        return true;
      }
      if (live.current) setError(messageFor(cause) ?? "Could not send the reset email.");
      return false;
    } finally {
      if (live.current) setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { status, user, error, busy, signIn, signUp, signInWithGoogle, signOut, resetPassword, clearError };
}
