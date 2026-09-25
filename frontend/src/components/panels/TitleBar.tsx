/**
 * Top nav bar: the only chrome that is always on screen.
 *
 * Left to right: the Orbital mark, the File/Search/Terminal/Help actions, the open project, the
 * centred workspace search, then the context-window gauge and the three panel toggles. The bar is
 * greyscale on purpose — `text-primary` marks an open panel and the gauge fill, nothing else.
 */

import { useEffect, useRef, useState } from "react";
import {
  FolderOpen,
  Info,
  Keyboard,
  PanelBottom,
  PanelLeft,
  PanelRight,
  RotateCcw,
  Save,
  type LucideIcon,
} from "lucide-react";

import { api } from "@/lib/api";
import { cn, formatDuration } from "@/lib/utils";
import { useOpenProject } from "@/hooks/useOpenProject";
import { useAppStore } from "@/store/app-store";
import { MetricRow } from "@/components/common/MetricRow";
import { toast } from "@/components/common/Toaster";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Wordmark } from "@/components/common/Wordmark";
import { NavMenuButton, NavMenuItem } from "@/components/panels/NavMenu";
import { NavSearch, type NavSearchHandle } from "@/components/panels/NavSearch";
import { UsageMeter } from "@/components/panels/UsageMeter";
import type { HealthResponse } from "@/types/protocol";

/** Only bindings that exist in this build; each one is asserted against its source file. */
const SHORTCUTS: ReadonlyArray<[action: string, keys: string]> = [
  ["Save the active file", "Ctrl/Cmd + S"],
  ["Focus workspace search", "Ctrl/Cmd + K"],
  ["Send a message to the agent", "Enter"],
  ["New line in the message composer", "Shift + Enter"],
  ["Dismiss a dialog or menu", "Escape"],
];

interface PanelToggleProps {
  icon: LucideIcon;
  label: string;
  open: boolean;
  onToggle: () => void;
}

/** One of the three panel toggles; they must all read identically, hence one component. */
function PanelToggle({ icon: Icon, label, open, onToggle }: PanelToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={open}
      title={`Toggle ${label}`}
      onClick={onToggle}
      className={cn(
        "flex h-[18px] w-[18px] items-center justify-center rounded transition-colors hover:bg-chrome-raised",
        open ? "text-primary" : "text-muted-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

export function TitleBar() {
  const projectName = useAppStore((s) => s.project?.name ?? null);
  const projectPath = useAppStore((s) => s.project?.projectPath ?? null);
  const setView = useAppStore((s) => s.setView);
  const inIde = useAppStore((s) => s.view === "ide");
  const backendBase = useAppStore((s) => s.backendBase);
  const leftPanel = useAppStore((s) => s.panels.left);
  const rightPanel = useAppStore((s) => s.panels.right);
  const bottomPanel = useAppStore((s) => s.panels.bottom);
  const togglePanel = useAppStore((s) => s.togglePanel);
  const saveActive = useAppStore((s) => s.saveActive);
  const resetRun = useAppStore((s) => s.resetRun);
  const { open, opening, error } = useOpenProject();

  const searchRef = useRef<NavSearchHandle>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);

  // The picker runs in the desktop host or the local runtime; both report failures here.
  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  // Runtime facts are read live, once, the first time the About dialog is opened.
  useEffect(() => {
    if (!showAbout || health !== null || healthFailed) return;
    let cancelled = false;
    void api.health().then(
      (response) => {
        if (!cancelled) setHealth(response);
      },
      () => {
        if (!cancelled) setHealthFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [showAbout, health, healthFailed]);

  const healthPending = healthFailed ? "unavailable" : "…";

  return (
    <>
      <header className="flex h-8 w-full shrink-0 items-center gap-3 border-b border-border bg-chrome px-3">
          {/* The left column: mark, nav and the open project. It and its counterpart on the right
              take an equal share of the bar, which is what actually centres the search. */}
          <div className="flex min-w-0 flex-1 items-center gap-3">
          {/* 1 — the Orbital mark. */}
          <Wordmark />

          {/* 2–5 — the nav actions. Only in the IDE: on the launcher there is no workspace to
              save into, no tree to search and no terminal to toggle, and the app-level buttons
              live in the launcher's own rail. */}
          {inIde ? (
            <nav className="flex shrink-0 items-center">
              <Button
                size="xs"
                variant="ghost"
                className="h-[18px] px-1.5 text-2xs"
                title="Back to your projects"
                onClick={() => setView("dashboard")}
              >
                Projects
              </Button>
              <NavMenuButton label="File">
                <NavMenuItem
                  icon={FolderOpen}
                  label="Open Folder…"
                  onSelect={() => {
                    // The picker is modal; a second request while one is open would stack dialogs.
                    if (!opening) void open();
                  }}
                />
                <NavMenuItem
                  icon={Save}
                  label="Save Active File"
                  hint="Ctrl/Cmd + S"
                  onSelect={() => void saveActive()}
                />
                <NavMenuItem icon={RotateCcw} label="Reset Session" destructive onSelect={resetRun} />
              </NavMenuButton>

              <Button
                size="xs"
                variant="ghost"
                className="h-[18px] px-1.5 text-2xs"
                title="Toggle the terminal panel"
                onClick={() => togglePanel("bottom")}
              >
                Terminal
              </Button>

              <NavMenuButton label="Help">
                <NavMenuItem
                  icon={Keyboard}
                  label="Keyboard shortcuts"
                  onSelect={() => setShowShortcuts(true)}
                />
                <NavMenuItem icon={Info} label="About Orbital" onSelect={() => setShowAbout(true)} />
              </NavMenuButton>
            </nav>
          ) : null}

          {/* The open project. It doubles as the way back to the launcher: the only other route is
              restarting the app, and switching projects is a normal thing to want. The folder path is
              a tooltip rather than a second line of text — it is long, it rarely changes, and it was
              pushing the search bar off centre. */}
          <div className="flex min-w-0 shrink items-center gap-2">
            <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />
            {projectName ? (
              <button
                type="button"
                onClick={() => setView("dashboard")}
                title={projectPath ? `All projects — ${projectPath}` : "All projects"}
                className="flex min-w-0 items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-chrome-raised focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span className="shrink-0 truncate text-2xs font-medium text-muted-foreground">{projectName}</span>
              </button>
            ) : (
              <span className="shrink-0 text-2xs text-muted-foreground/60">No folder open</span>
            )}
          </div>

        </div>
        <div className="flex min-w-0 flex-1 justify-center">
          <NavSearch ref={searchRef} />
        </div>

        {/* 7–8 — context window, then which panels are open. IDE state, so launcher-free. */}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-5">
          {inIde ? (
            <>
              <UsageMeter />
              <div className="flex items-center gap-0.5">
                <PanelToggle
                  icon={PanelLeft}
                  label="left panel"
                  open={leftPanel}
                  onToggle={() => togglePanel("left")}
                />
                <PanelToggle
                  icon={PanelRight}
                  label="right panel"
                  open={rightPanel}
                  onToggle={() => togglePanel("right")}
                />
                <PanelToggle
                  icon={PanelBottom}
                  label="bottom panel"
                  open={bottomPanel}
                  onToggle={() => togglePanel("bottom")}
                />
              </div>
            </>
          ) : null}
        </div>
      </header>

      <Dialog open={showShortcuts} onOpenChange={setShowShortcuts}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>Every shortcut this build binds.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col">
            {SHORTCUTS.map(([action, keys]) => (
              <MetricRow key={action} label={action} value={keys} mono />
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showAbout} onOpenChange={setShowAbout}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>About Orbital</DialogTitle>
            <DialogDescription>The runtime this window is talking to.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col">
            <MetricRow label="Version" value={health?.version ?? healthPending} mono />
            <MetricRow label="Model" value={health?.model ?? healthPending} mono />
            <MetricRow
              label="Protocol"
              value={health ? `v${health.protocolVersion}` : healthPending}
              mono
            />
            <MetricRow
              label="Uptime"
              value={health ? formatDuration(health.uptimeSeconds * 1000) : healthPending}
              mono
            />
            <MetricRow label="Backend" value={backendBase ?? "unknown"} mono />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
