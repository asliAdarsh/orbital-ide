import { useEffect } from "react";
import { FileText, GitBranch, Settings } from "lucide-react";

import { useAppStore } from "@/store/app-store";
import { usePanelSize } from "@/hooks/usePanelSize";
import { api, errorMessage } from "@/lib/api";
import { languageFor } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileTree } from "@/components/editor/FileTree";
import { SectionLabel } from "@/components/common/SectionLabel";
import { toast } from "@/components/common/Toaster";
import { PhaseStepper } from "@/components/phases/PhaseStepper";
import { ProfilePopover } from "@/components/panels/ProfilePopover";
import { SessionsPanel } from "@/components/panels/SessionsPanel";
import { AGENTS_MD_PATH, PLAN_PATH, TEST_REPORT_PATH } from "@/types/protocol";

/** Context artefacts the pipeline produces, in the order the phases create them. */
// Absolute-from-root paths, because that is how the store keys artefacts and how the orchestrator
// mirrors them — a bare name would never match what the backend reports.
const CONTEXT_FILES = [PLAN_PATH, TEST_REPORT_PATH, AGENTS_MD_PATH] as const;

const TREE_DEBOUNCE_MS = 400;

/** Wide enough for nested workspace paths, which is what used to clip. */
const MIN_WIDTH = 200;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 288;

export function LeftSidebar() {
  const activePhase = useAppStore((s) => s.activePhase);
  const phaseStatus = useAppStore((s) => s.phaseStatus);
  const setActivePhase = useAppStore((s) => s.setActivePhase);
  const artifacts = useAppStore((s) => s.artifacts);
  const tree = useAppStore((s) => s.tree);
  const treeVersion = useAppStore((s) => s.treeVersion);
  const projectPath = useAppStore((s) => s.project?.projectPath ?? null);
  const git = useAppStore((s) => s.project?.git ?? null);
  const activeFilePath = useAppStore((s) => s.activeFilePath);
  const setTree = useAppStore((s) => s.setTree);
  const openFile = useAppStore((s) => s.openFile);
  const pushLog = useAppStore((s) => s.pushLog);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

  const { size: width, handleProps } = usePanelSize({
    storageKey: "orbital.leftSidebarWidth",
    initial: DEFAULT_WIDTH,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    grow: "right",
    label: "left sidebar",
  });

  useEffect(() => {
    if (!projectPath) return;
    const timer = window.setTimeout(() => {
      void api
        .tree()
        .then(setTree)
        .catch((err: unknown) => pushLog("warn", `Workspace tree refresh failed: ${errorMessage(err)}`));
    }, TREE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [treeVersion, projectPath, setTree, pushLog]);

  const handleOpenArtifact = (name: string) => {
    const content = artifacts[name];
    if (!content) {
      toast.error(`${name} has not been generated yet.`);
      return;
    }
    openFile({
      path: name,
      content,
      language: languageFor(name),
      truncated: false,
      bytes: new TextEncoder().encode(content).length,
    });
  };

  const handleOpenTreeFile = (path: string) => {
    void api
      .readFile(path)
      .then(openFile)
      .catch((err: unknown) => toast.error(errorMessage(err)));
  };

  return (
    <aside
      style={{ width }}
      className="relative flex shrink-0 flex-col border-r border-border bg-chrome"
    >
      {/* Sits astride the border so the grab target is wider than the line itself. */}
      <div {...handleProps} className="group absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize">
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-primary" />
      </div>
      {/* Conversations first: which chat this window is on is what everything below it acts on, and
          the phase stepper and the tree are both per-session views of the open folder. */}
      <SessionsPanel />
      <SectionLabel>Phases</SectionLabel>
      <PhaseStepper activePhase={activePhase} status={phaseStatus} onSelect={setActivePhase} />

      <SectionLabel>Context</SectionLabel>
      <div className="flex shrink-0 flex-col">
        {CONTEXT_FILES.map((name) => {
          const available = Boolean(artifacts[name]);
          return (
            <button
              key={name}
              type="button"
              disabled={!available}
              onClick={() => handleOpenArtifact(name)}
              className={cn(
                "flex items-center gap-2 border-b border-border px-3 py-1.5 text-left",
                available ? "hover:bg-chrome-raised" : "cursor-default",
              )}
            >
              <FileText className={cn("h-3.5 w-3.5 shrink-0", available ? "text-primary" : "text-muted-foreground")} />
              <span className={cn("min-w-0 flex-1 truncate font-mono text-2xs", available ? "text-foreground" : "text-muted-foreground")}>
                {name}
              </span>
              <span className="shrink-0 font-mono text-2xs text-muted-foreground">{available ? "open" : "pending"}</span>
            </button>
          );
        })}
      </div>

      <SectionLabel right={tree ? <span className="font-mono text-2xs text-muted-foreground">{tree.name}</span> : null}>
        Workspace
      </SectionLabel>
      <ScrollArea className="min-h-0 flex-1">
        {tree ? (
          <FileTree root={tree} onOpenFile={handleOpenTreeFile} activePath={activeFilePath} />
        ) : (
          <p className="px-3 py-2 text-2xs text-muted-foreground">No folder open.</p>
        )}
      </ScrollArea>

      {git && (
        <div className="shrink-0 border-t border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-2xs text-foreground">{git.branch ?? "no branch"}</span>
            <span className={cn("shrink-0 font-mono text-2xs", git.dirty ? "text-phase-test" : "text-muted-foreground")}>
              {git.dirty ? `${git.changed.length} changed` : "clean"}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-3 font-mono text-2xs text-muted-foreground">
            <span>ahead {git.ahead}</span>
            <span>behind {git.behind}</span>
            {!git.repo && <span className="shrink-0 text-phase-test">no repo</span>}
          </div>
          {git.error && (
            <div className="mt-1 break-words font-mono text-2xs text-destructive">{git.error}</div>
          )}
        </div>
      )}

      {/* Pinned to the bottom: settings and the provider credential. */}
      <div className="flex h-9 shrink-0 items-center justify-between border-t border-border px-2">
        <Button variant="ghost" size="icon" aria-label="Open settings" onClick={() => setSettingsOpen(true)}>
          <Settings className="h-4 w-4" />
        </Button>
        <ProfilePopover />
      </div>
    </aside>
  );
}
