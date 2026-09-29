import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";

import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { Toaster } from "@/components/common/Toaster";
import { LoginPage } from "@/components/auth/LoginPage";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CentrePane } from "@/components/layout/CentrePane";
import { Dashboard } from "@/components/dashboard/Dashboard";
import { BottomPanel } from "@/components/panels/BottomPanel";
import { LeftSidebar } from "@/components/panels/LeftSidebar";
import { RightSidebar } from "@/components/panels/RightSidebar";
import { SettingsDialog } from "@/components/panels/SettingsDialog";
import { TitleBar } from "@/components/panels/TitleBar";
import { ProviderDialog } from "@/components/onboarding/ProviderDialog";
import { endAgentSession, openAgentSession, useAgentSocket } from "@/hooks/useAgentSocket";
import { useAuth } from "@/hooks/useAuth";
import { useBackendBoot } from "@/hooks/useBackendBoot";
import { useProviders } from "@/hooks/useProviders";
import { useAppStore } from "@/store/app-store";

/**
 * Where this machine's answer to the provider dialog is remembered, per account.
 *
 * Machine-local on purpose: which endpoints this computer has a key for is a fact about this
 * computer, and a profile the runtime migrated out of `.env` is not evidence that anybody chose it.
 * The flag says the question has been *asked* — "Later" and setting a provider are both answers to
 * it — so nobody is asked twice, and nobody whose setup was never confirmed is left without being
 * asked at all.
 */
const PROVIDER_ASKED_PREFIX = "orbital.providerPrompt.";

/** Read tolerating disabled storage: a browser with no localStorage must not break the dialog. */
function providerAsked(uid: string): boolean {
  try {
    return window.localStorage.getItem(PROVIDER_ASKED_PREFIX + uid) === "1";
  } catch {
    return false;
  }
}

function rememberProviderAsked(uid: string): void {
  try {
    window.localStorage.setItem(PROVIDER_ASKED_PREFIX + uid, "1");
  } catch {
    // The answer still holds for this session; only the memory of it is lost.
  }
}

/**
 * Shown while the Python sidecar starts and when it never answers, and — with `note` — while
 * the persisted sign-in is being restored. The two waits are the same shape to the user, so
 * they are the same screen.
 */
function BootScreen({
  error,
  onRetry,
  note = "Connecting to the agent runtime…",
}: {
  error: string | null;
  onRetry: () => void;
  note?: string;
}) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-6 bg-background hatch">
      <div className="flex flex-col items-center gap-2">
        <div className="font-mono text-sm uppercase tracking-[0.42em] text-primary">Orbital</div>
        <div className="text-2xs uppercase tracking-[0.2em] text-muted-foreground">
          Agent runtime
        </div>
      </div>

      {error ? (
        <div className="flex w-full max-w-md flex-col gap-3 border border-destructive/40 bg-destructive/5 p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-destructive">
            <TriangleAlert className="h-4 w-4" />
            The agent runtime is not responding
          </div>
          <p className="font-mono text-2xs leading-relaxed text-muted-foreground">{error}</p>
          <p className="text-2xs leading-relaxed text-muted-foreground">
            Start it with <span className="font-mono">npm run backend:dev</span> from the repository
            root, then retry. The desktop build starts it automatically.
          </p>
          <div>
            <Button size="sm" onClick={onRetry}>
              <RefreshCw className="h-3 w-3" />
              Retry
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          {note}
        </div>
      )}
    </div>
  );
}

/**
 * Everything that talks to the runtime on behalf of a signed-in user — the workspace, the shell.
 *
 * It is a separate component because it must not exist for a signed-out user: the shell registers a
 * session, watches the filesystem and holds a terminal, and a tree that is merely hidden would do
 * all of that before anyone has signed in.
 *
 * The agent socket is not opened from here. It is a module singleton whose life is bound to the
 * uid by the effect in `App` — this tree is unmounted the moment the account goes away, so a
 * connection owned by it would outlive the account it belongs to.
 */
function Workspace() {
  const view = useAppStore((state) => state.view);
  const projectPath = useAppStore((state) => state.project?.projectPath ?? null);
  const panels = useAppStore((state) => state.panels);
  const { watch } = useAgentSocket();

  // Subscribe to filesystem changes as soon as a workspace is bound.
  useEffect(() => {
    if (projectPath) watch(projectPath);
  }, [projectPath, watch]);

  return (
    <TooltipProvider>
      <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground">
        {/* The launcher draws its own bar — its nav is projects and settings, not files and
            terminals — so the IDE's title bar appears only once there is a workspace. */}
        {view === "ide" ? <TitleBar /> : null}
        {view === "dashboard" ? (
          <Dashboard />
        ) : (
          <div className="flex min-h-0 flex-1">
            {panels.left && <LeftSidebar />}
            <div className="flex min-w-0 flex-1 flex-col">
              <CentrePane />
              {panels.bottom && <BottomPanel />}
            </div>
            {panels.right && <RightSidebar />}
          </div>
        )}
      </div>
      <SettingsDialog />
      <Toaster />
    </TooltipProvider>
  );
}

export default function App() {
  const { ready, error, retry } = useBackendBoot();
  const { status, user } = useAuth();
  const bindAccount = useAppStore((state) => state.bindAccount);
  const backendBase = useAppStore((state) => state.backendBase);
  // Mounted here, in the one component that lives for the whole signed-in session, for the side
  // effect rather than the list: `useProviders` runs the sync that keeps an `orbital` profile's key
  // equal to the account's current ID token, and a screen that is not the settings dialog must not
  // be what decides whether that happens. Its own list is discarded — every screen that shows
  // providers reads its own, so none of them can be showing another's stale one.
  useProviders();
  // The account whose dialog has been answered in this session — by setting a provider up or by
  // choosing "Later". Keyed by uid rather than a flag, so signing in as someone else is asked
  // again instead of inheriting this session's answer.
  const [answered, setAnswered] = useState<string | null>(null);
  const uid = status === "signed-in" ? (user?.uid ?? null) : null;
  // The account the socket was last reconciled to; `undefined` until `useAuth` settles for the
  // first time, so its initial "loading" is never read as a signed-out state.
  const boundUid = useRef<string | null | undefined>(undefined);

  /**
   * The socket's life is bound to the account here, in the one component that outlives the dialog.
   *
   * It cannot live in the shell below or in `useAgentSocket`: signing out closes the gate, which
   * unmounts that whole tree, so a connection owned by it would keep streaming the previous
   * account's run — and keep spending their credential — while the login page is on screen. The
   * uid, not the window, is what a session belongs to.
   *
   * Every path runs through the same pair: a uid appearing opens a socket subscribed to *that*
   * account, and a uid going away cancels its run, closes the socket and clears what the socket
   * wrote to the store. The composer's provider pin is loaded from the same uid, because it is that
   * account's choice and must not outlive it.
   */
  useEffect(() => {
    // Firebase has not said who this is yet. Acting now would treat a restored session as a
    // signed-out user and take down a session nobody asked to end.
    if (status === "loading") return;
    if (boundUid.current === uid) {
      // Already reconciled for this account. The one thing left to do is (re)connect, because the
      // runtime's origin can arrive after the uid does.
      if (uid !== null && backendBase !== null) openAgentSession(backendBase, uid);
      return;
    }
    boundUid.current = uid;
    bindAccount(uid);
    if (uid === null) {
      // Sign-out, or the switch to another account: nothing may stay connected while there is no
      // uid, and none of the previous account's session may render for the next one.
      endAgentSession();
      return;
    }
    // The origin may not be known yet — the boot sequence resolves it — in which case this effect
    // runs again when it is, with the same uid.
    if (backendBase !== null) openAgentSession(backendBase, uid);
  }, [status, uid, backendBase, bindAccount]);

  if (!ready) return <BootScreen error={error} onRetry={retry} />;
  // `loading` must not fall through to the login page: Firebase restores a persisted session
  // asynchronously, so the gate is closed for a moment for everyone, signed in or not.
  if (status === "loading") {
    return <BootScreen error={null} onRetry={retry} note="Checking your session…" />;
  }
  if (status === "signed-out") return <LoginPage />;

  /**
   * Asked once per account, and not gated on the profile list.
   *
   * Having a profile is not the same as having chosen one: a key the runtime migrated out of
   * `.env` produces a profile nobody picked, and the old test — "no profiles at all" — is exactly
   * why that user was never shown a way to choose. So this asks on the machine-local answer alone,
   * and the dialog is what looks at the profiles.
   */
  const askForProvider = uid !== null && answered !== uid && !providerAsked(uid);

  return (
    <>
      <Workspace />
      {askForProvider ? (
        <ProviderDialog
          onDismiss={() => {
            rememberProviderAsked(uid);
            setAnswered(uid);
          }}
        />
      ) : null}
    </>
  );
}

/** Top-level guard so a render failure shows a readable panel instead of a blank window. */
export function Root() {
  return (
    <ErrorBoundary fallbackTitle="Orbital hit an unexpected error">
      <App />
    </ErrorBoundary>
  );
}
