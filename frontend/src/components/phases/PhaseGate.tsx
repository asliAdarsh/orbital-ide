/**
 * The between-phase approval gate.
 *
 * A run stops at the end of each phase by default. The orchestrator's verdict is on screen,
 * every artefact is on disk and editable, and nothing else starts until the user says so —
 * which is the point at which a wrong plan or a half-written design is still cheap to fix.
 *
 * "Run all phases without stopping" restores the old chain-the-whole-pipeline behaviour.
 */

import { CheckCircle2, RotateCcw, SkipForward, TriangleAlert } from "lucide-react";

import { useAgentSocket } from "@/hooks/useAgentSocket";
import { PHASE_PROMPTS } from "@/lib/phase-prompts";
import { useAppStore } from "@/store/app-store";
import { DESIGN_DIR, PHASE_SPECS, type FileNode, type Phase } from "@/types/protocol";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/common/StatusDot";

/**
 * Everything the pipeline writes about the project lives under `agent/`, so that one directory is
 * what gets excluded when counting what the application itself consists of — the plan, the design
 * mocks and the test report are all output of the pipeline, not part of the delivered app.
 */
const PIPELINE_DIR = "agent";

/** Count the design mocks on disk, which is how phase 2's deliverable is judged. */
function countDesignMocks(node: FileNode | null, prefix = ""): number {
  if (!node) return 0;
  let total = 0;
  for (const child of node.children ?? []) {
    const path = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.type === "file") {
      if (path.startsWith(`${DESIGN_DIR}/`) && path.endsWith(".html")) total += 1;
    } else if (!child.ignored) {
      total += countDesignMocks(child, path);
    }
  }
  return total;
}

/** Count workspace files that belong to the application rather than to the pipeline. */
function countSourceFiles(node: FileNode | null): number {
  if (!node) return 0;
  let total = 0;
  for (const child of node.children ?? []) {
    if (child.type === "file") {
      total += 1;
    } else if (!child.ignored && child.name !== PIPELINE_DIR) {
      total += countSourceFiles(child);
    }
  }
  return total;
}

export function PhaseGate() {
  const activePhase = useAppStore((s) => s.activePhase);
  const phaseStatus = useAppStore((s) => s.phaseStatus);
  const artifacts = useAppStore((s) => s.artifacts);
  const tree = useAppStore((s) => s.tree);
  const running = useAppStore((s) => s.running);
  const autoAdvance = useAppStore((s) => s.autoAdvance);
  const setAutoAdvance = useAppStore((s) => s.setAutoAdvance);
  const projectPath = useAppStore((s) => s.project?.projectPath ?? null);
  const socket = useAgentSocket();

  const index = PHASE_SPECS.findIndex((info) => info.id === activePhase);
  const spec = index >= 0 ? PHASE_SPECS[index] : undefined;
  const next = index >= 0 && index + 1 < PHASE_SPECS.length ? PHASE_SPECS[index + 1] : undefined;
  const status = phaseStatus[activePhase];

  // A phase that reported success but left nothing behind has not actually delivered — say so
  // here rather than letting the next phase build on a document (or a codebase) that is not
  // there. The build phase's deliverable is a tree of files, not a single named document.
  const deliverable = spec?.deliverable ?? "";
  let missingNote: string | null = null;
  if (status === "done") {
    if (deliverable.endsWith(".md") && artifacts[deliverable] === undefined) {
      missingNote = `${deliverable} was not written`;
    } else if (activePhase === "design" && countDesignMocks(tree) === 0) {
      missingNote = `no mocks were written to ${DESIGN_DIR}/`;
    } else if (activePhase === "build" && countSourceFiles(tree) === 0) {
      missingNote = "no source files were written";
    }
  }

  const start = (phase: Phase) => {
    if (!projectPath) return;
    socket.run(phase, PHASE_PROMPTS[phase], projectPath, false);
  };

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-t border-border bg-chrome px-3">
      <StatusDot state={status} pulse={running} />
      <span className="shrink-0 font-mono text-2xs uppercase tracking-wider text-muted-foreground">
        {spec ? `Phase ${spec.index}/${PHASE_SPECS.length}` : "Phase"}
      </span>

      {missingNote && (
        <span className="flex items-center gap-1.5 truncate text-2xs text-phase-test">
          <TriangleAlert className="h-3 w-3 shrink-0" />
          {missingNote}
        </span>
      )}

      <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 text-2xs text-muted-foreground">
        <input
          type="checkbox"
          checked={autoAdvance}
          onChange={(event) => setAutoAdvance(event.target.checked)}
          className="h-3 w-3 accent-primary"
        />
        run all phases without stopping
      </label>

      {!autoAdvance && !running && status !== "idle" && (
        <div className="flex shrink-0 items-center gap-1.5 border-l border-border pl-3">
          {status === "done" &&
            (next ? (
              <Button size="xs" onClick={() => start(next.id)} disabled={!projectPath}>
                <SkipForward className="h-3 w-3" />
                Approve · continue to {next.title}
              </Button>
            ) : (
              <span className="flex items-center gap-1.5 text-2xs text-primary">
                <CheckCircle2 className="h-3 w-3" />
                pipeline complete
              </span>
            ))}
          <Button
            size="xs"
            variant={status === "error" ? "default" : "outline"}
            onClick={() => start(activePhase)}
            disabled={!projectPath}
          >
            <RotateCcw className="h-3 w-3" />
            {status === "error" ? "Retry this phase" : "Re-run this phase"}
          </Button>
        </div>
      )}
    </div>
  );
}
