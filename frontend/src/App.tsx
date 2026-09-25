import { useEffect } from "react";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";

import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { Toaster } from "@/components/common/Toaster";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CentrePane } from "@/components/layout/CentrePane";
import { Dashboard } from "@/components/dashboard/Dashboard";
import { BottomPanel } from "@/components/panels/BottomPanel";
import { LeftSidebar } from "@/components/panels/LeftSidebar";
import { RightSidebar } from "@/components/panels/RightSidebar";
import { SettingsDialog } from "@/components/panels/SettingsDialog";
import { TitleBar } from "@/components/panels/TitleBar";
import { useAgentSocket } from "@/hooks/useAgentSocket";
import { useBackendBoot } from "@/hooks/useBackendBoot";
import { useAppStore } from "@/store/app-store";

/** Shown while the Python sidecar starts, and when it never answers. */
function BootScreen({ error, onRetry }: { error: string | null; onRetry: () => void }) {
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
          Connecting to the agent runtime…
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { ready, error, retry } = useBackendBoot();
  const view = useAppStore((state) => state.view);
  const projectPath = useAppStore((state) => state.project?.projectPath ?? null);
  const panels = useAppStore((state) => state.panels);
  const { watch } = useAgentSocket();

  // Subscribe to filesystem changes as soon as a workspace is bound.
  useEffect(() => {
    if (projectPath) watch(projectPath);
  }, [projectPath, watch]);

  if (!ready) return <BootScreen error={error} onRetry={retry} />;

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

/** Top-level guard so a render failure shows a readable panel instead of a blank window. */
export function Root() {
  return (
    <ErrorBoundary fallbackTitle="Orbital hit an unexpected error">
      <App />
    </ErrorBoundary>
  );
}
