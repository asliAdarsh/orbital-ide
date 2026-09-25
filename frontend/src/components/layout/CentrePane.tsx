/**
 * The centre surface of the IDE.
 *
 * A pinned "Phase" tab sits next to one tab per open file, mirroring how an editor
 * keeps a permanent tab: selecting Phase returns to the five-phase canvas without
 * closing anything. The body switches between the phase canvas, Monaco, and the diff
 * view, driven entirely by store state.
 */

import { Layers } from "lucide-react";

import { CodeEditor } from "@/components/editor/CodeEditor";
import { DiffViewer } from "@/components/editor/DiffViewer";
import { EditorTabs } from "@/components/editor/EditorTabs";
import { PhaseCanvas } from "@/components/phases";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";

export function CentrePane() {
  // Only reachable with a project bound — the launcher gates the IDE — so there is no
  // no-project branch here.
  const openFiles = useAppStore((state) => state.openFiles);
  const activeFilePath = useAppStore((state) => state.activeFilePath);
  const diff = useAppStore((state) => state.diff);
  const setActiveFilePath = useAppStore((state) => state.setActiveFilePath);
  const closeFile = useAppStore((state) => state.closeFile);
  const editFile = useAppStore((state) => state.editFile);
  const saveActive = useAppStore((state) => state.saveActive);

  const activeFile = openFiles.find((file) => file.path === activeFilePath) ?? null;
  const showPhase = activeFile === null && diff === null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-8 shrink-0 items-stretch border-b border-border bg-chrome">
        <button
          type="button"
          onClick={() => setActiveFilePath(null)}
          className={cn(
            "flex shrink-0 items-center gap-1.5 border-r border-border px-3 text-2xs font-medium uppercase tracking-[0.14em] transition-colors",
            showPhase ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Layers className="h-3 w-3" />
          Phase
        </button>
        <div className="min-w-0 flex-1">
          <EditorTabs
            files={openFiles}
            activePath={activeFilePath}
            onSelect={setActiveFilePath}
            onClose={closeFile}
            onSave={() => void saveActive()}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {diff ? (
          <DiffViewer path={diff.path} original={diff.original} modified={diff.modified} />
        ) : activeFile ? (
          <CodeEditor
            path={activeFile.path}
            value={activeFile.content}
            language={activeFile.language}
            onChange={(value) => editFile(activeFile.path, value)}
            onSave={() => void saveActive()}
          />
        ) : (
          <PhaseCanvas />
        )}
      </div>
    </div>
  );
}
