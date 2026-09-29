/**
 * The sign-in gate: one card, two modes, and validation that runs before Firebase is asked
 * anything.
 *
 * A round trip only ever comes back with "that address is malformed" after a second of waiting
 * and a network, so the shallow checks the browser could do itself happen here first. Deeper
 * questions — does this address have an account, is this the right password — stay Firebase's,
 * because the answer to those is also the answer a stranger should not be given.
 *
 * Prop-less on purpose: it reads the signed-in state from {@link useAuth} and the config from
 * `lib/firebase`, so the gate in `App` is the only thing that has to know it exists.
 */

import { useState, type FormEvent, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

import { Wordmark } from "@/components/common/Wordmark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/useAuth";
import { firebaseConfigError, usingAuthEmulator } from "@/lib/firebase";
import { cn } from "@/lib/utils";

type Mode = "sign-in" | "create";

const MODES: ReadonlyArray<{ id: Mode; label: string }> = [
  { id: "sign-in", label: "Sign in" },
  { id: "create", label: "Create account" },
];

/** Firebase refuses anything shorter, so say it here rather than after a round trip. */
const MIN_PASSWORD = 8;

export interface CredentialErrors {
  email: string | null;
  password: string | null;
  confirm: string | null;
}

const NO_ERRORS: CredentialErrors = { email: null, password: null, confirm: null };

/**
 * Whether an address is plausible: one `@`, something either side, and a dot in the domain.
 *
 * Deliberately not RFC 5322 — Firebase is the authority on whether an address works, and a form
 * that refuses a valid one is worse than a form that lets the server explain itself.
 */
function emailProblem(address: string): string | null {
  if (address === "") return "Enter your email address.";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? null : "That email address does not look right.";
}

function passwordProblem(password: string): string | null {
  if (password === "") return "Enter your password.";
  return password.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : null;
}

/**
 * What is wrong with the form, field by field. `confirmation` is null in sign-in mode, where
 * there is nothing to confirm — hence three slots rather than one message.
 */
export function validateCredentials(
  email: string,
  password: string,
  confirmation: string | null,
): CredentialErrors {
  return {
    email: emailProblem(email.trim()),
    password: passwordProblem(password),
    confirm:
      confirmation === null
        ? null
        : confirmation === ""
          ? "Repeat your password."
          : confirmation === password
            ? null
            : "The two passwords do not match.",
  };
}

/**
 * Google's four-colour G, inlined.
 *
 * Brand colours as literals rather than theme tokens: the mark has to look the same on every
 * surface, and a token would be re-tinted by whatever is behind it. Inlined so that neither a
 * remote image nor a dependency is needed for one 700-byte asset.
 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden className="h-3.5 w-3.5">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/** The window frame every state shares: hatch background, centred column, the mark on top. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center overflow-y-auto bg-background hatch px-4 py-8">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <Wordmark />
        {children}
      </div>
    </div>
  );
}

interface FieldProps {
  label: string;
  type: "email" | "password";
  value: string;
  autoComplete: string;
  error: string | null;
  onChange(value: string): void;
}

/** Label, input and its own message — a message about a field belongs under that field. */
function Field({ label, type, value, autoComplete, error, onChange }: FieldProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <Input
        type={type}
        value={value}
        autoComplete={autoComplete}
        aria-invalid={error !== null}
        className="h-8"
        onChange={(event) => onChange(event.target.value)}
      />
      {error !== null ? <span className="text-2xs text-destructive">{error}</span> : null}
    </label>
  );
}

export function LoginPage() {
  const { busy, error, signIn, signUp, signInWithGoogle, resetPassword, clearError } = useAuth();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [fieldErrors, setFieldErrors] = useState<CredentialErrors>(NO_ERRORS);
  const [resetSent, setResetSent] = useState(false);

  // Missing configuration is a page state, not a form state: there is nothing to submit to, so
  // the card becomes the sentence naming what to add. Every hook above runs either way.
  if (firebaseConfigError !== null) {
    return (
      <Frame>
        <div className="flex flex-col gap-3 border border-border bg-chrome p-5">
          <div className="flex items-center gap-2 text-xs font-medium text-destructive">
            <TriangleAlert className="h-4 w-4 shrink-0" />
            Firebase is not configured
          </div>
          <p className="font-mono text-2xs leading-relaxed text-muted-foreground">{firebaseConfigError}</p>
        </div>
      </Frame>
    );
  }

  /**
   * Editing a field retires the messages about it: a red line that outlives the text it
   * complained about reads as a second, unfixable problem.
   */
  const dismiss = (field: keyof CredentialErrors) => {
    setFieldErrors((current) => ({ ...current, [field]: null }));
    setResetSent(false);
    if (error !== null) clearError();
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setFieldErrors(NO_ERRORS);
    setResetSent(false);
    if (error !== null) clearError();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    const problems = validateCredentials(address, password, mode === "create" ? confirmation : null);
    setFieldErrors(problems);
    setResetSent(false);
    if (problems.email !== null || problems.password !== null || problems.confirm !== null) return;
    if (mode === "create") await signUp(address, password);
    else await signIn(address, password);
  };

  const requestReset = async () => {
    const problem = emailProblem(email.trim());
    if (problem !== null) {
      // A reset needs an address and nothing else, so ask for one now rather than failing later
      // with a message about a password the user never had to type.
      setFieldErrors({ ...NO_ERRORS, email: problem });
      return;
    }
    setResetSent(await resetPassword(email.trim()));
  };

  return (
    <Frame>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-sm font-medium text-foreground">Sign in to Orbital</h1>
          <p className="text-2xs leading-relaxed text-muted-foreground">
            Your projects, runs and provider key follow the account you sign in with.
          </p>
        </div>

        {/* noValidate: the browser's own bubbles speak a different language from the inline
            messages below, and only one of the two can be tested. */}
        <form noValidate onSubmit={(event) => void submit(event)}>
          {/* One element disables every control at once, so a submit in flight cannot be
              reshaped by a half-typed second attempt. */}
          <fieldset
            disabled={busy}
            className="m-0 flex min-w-0 flex-col gap-3 border border-border bg-chrome p-5"
          >
            {/* Segmented, like the composer's mode toggle: two mutually exclusive choices, one
                of which is always on. */}
            <div role="group" aria-label="Account mode" className="flex items-center rounded border border-border">
              {MODES.map((option, index) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={mode === option.id}
                  onClick={() => switchMode(option.id)}
                  className={cn(
                    "h-7 flex-1 text-2xs text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-primary/10 aria-pressed:text-foreground disabled:pointer-events-none disabled:opacity-50",
                    index > 0 && "border-l border-border",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <Field
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              error={fieldErrors.email}
              onChange={(next) => {
                setEmail(next);
                dismiss("email");
              }}
            />
            <Field
              label="Password"
              type="password"
              autoComplete={mode === "create" ? "new-password" : "current-password"}
              value={password}
              error={fieldErrors.password}
              onChange={(next) => {
                setPassword(next);
                dismiss("password");
              }}
            />
            {mode === "create" ? (
              <Field
                label="Confirm password"
                type="password"
                autoComplete="new-password"
                value={confirmation}
                error={fieldErrors.confirm}
                onChange={(next) => {
                  setConfirmation(next);
                  dismiss("confirm");
                }}
              />
            ) : null}

            {error !== null ? <p className="text-2xs text-destructive">{error}</p> : null}
            {resetSent ? (
              <p className="text-2xs text-primary">Check your inbox — the link expires in an hour.</p>
            ) : null}

            <Button type="submit" size="md" className="w-full" loading={busy}>
              {mode === "create" ? "Create account" : "Sign in"}
            </Button>

            {mode === "sign-in" ? (
              <button
                type="button"
                onClick={() => void requestReset()}
                className="self-start text-2xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-50"
              >
                Forgot password?
              </button>
            ) : null}

            <div className="flex items-center gap-2 text-2xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>

            <Button
              type="button"
              variant="secondary"
              size="md"
              className="w-full"
              onClick={() => void signInWithGoogle()}
            >
              <GoogleMark />
              Continue with Google
            </Button>
          </fieldset>
        </form>

        {usingAuthEmulator ? (
          <p className="border border-border bg-chrome-sunken px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
            The Firebase emulator is in use: the accounts created here are local test accounts, not real
            ones.
          </p>
        ) : null}
      </div>
    </Frame>
  );
}
