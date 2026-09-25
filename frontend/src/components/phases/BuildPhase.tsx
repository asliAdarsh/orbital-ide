import { useMemo } from "react";
import { Hammer, Play, Square } from "lucide-react";

import { useAppStore } from "@/store/app-store";
import { PHASE_SPECS, type FileNode } from "@/types/protocol";
import { cn, formatDuration } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SectionLabel } from "@/components/common/SectionLabel";
import { MetricRow } from "@/components/common/MetricRow";
import { StatusDot } from "@/components/common/StatusDot";
import { PHASE_RAIL } from "@/components/phases/PhaseStepper";
import { PHASE_PROMPTS } from "@/lib/phase-prompts";

const SPEC = PHASE_SPECS[2];
const DEFAULT_PROMPT = PHASE_PROMPTS.build;
/** Tool results the build phase surfaces in its activity list. */
const BUILD_TOOLS = ["write_file", "run_command"];

function countNodes(node: FileNode): { files: number; dirs: number } {
  if (node.type === "file") return { files: 1, dirs: 0 };
  let files = 0;
  let dirs = 0;
  for (const child of node.children ?? []) {
    const counted = countNodes(child);
    files += counted.files;
    dirs += counted.dirs + (child.type === "directory" ? 1 : 0);
  }
  return { files, dirs };
}

function describeArgs(args: Record<string, unknown>): string {
  const path = args.path;
  if (typeof path === "string") return path;
  const command = args.command;
  if (typeof command === "string") return command;
  return "(no path or command)";
}

interface PhaseRuntimeProps {
  onRun: (prompt: string) => void;
  onCancel: () => void;
  running: boolean;
}

export function BuildPhase({ onRun, onCancel, running }: PhaseRuntimeProps) {
  const tree = useAppStore((s) => s.tree);
  const toolCalls = useAppStore((s) => s.toolCalls);
  const toolResults = useAppStore((s) => s.toolResults);
  const status = useAppStore((s) => s.phaseStatus.build);

  const counts = useMemo(() => (tree ? countNodes(tree) : { files: 0, dirs: 0 }), [tree]);
  const recent = useMemo(
    () => toolCalls.filter((call) => BUILD_TOOLS.includes(call.name)).slice(0, 20),
    [toolCalls],
  );

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="relative flex shrink-0 items-center gap-2 border-b border-border bg-chrome-raised py-2 pl-3 pr-2">
        <span className={cn("absolute inset-y-0 left-0 w-0.5", PHASE_RAIL[SPEC.id])} />
        <span className="flex h-5 w-5 shrink-0 items-center justify-center border border-border bg-chrome-sunken font-mono text-2xs text-muted-foreground">
          {SPEC.index}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{SPEC.title}</span>
        <span className="shrink-0 border border-border bg-chrome px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">{SPEC.agent}</span>
        <span className="shrink-0 font-mono text-2xs text-muted-foreground">{SPEC.deliverable}</span>
        <StatusDot state={status} />
      </header>

      <div className="shrink-0 divide-y divide-border border-b border-border">
        <MetricRow label="Workspace root" value={tree?.name ?? "no folder open"} mono />
        <MetricRow label="Files" value={String(counts.files)} mono />
        <MetricRow label="Directories" value={String(counts.dirs)} mono />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <SectionLabel right={<span className="font-mono text-2xs text-muted-foreground">{recent.length}</span>}>
          Recent writes and commands
        </SectionLabel>
        <ScrollArea className="min-h-0 flex-1">
          {recent.length === 0 ? (
            <p className="px-3 py-2 text-2xs text-muted-foreground">No file or command activity yet.</p>
          ) : (
            recent.map((call) => {
              const result = toolResults[call.id];
              return (
                <div key={call.id} className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                  <Badge variant={result && !result.ok ? "danger" : "secondary"}>{call.name}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-2xs text-foreground">{describeArgs(call.args)}</span>
                  <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                    {result ? formatDuration(result.durationMs) : "running"}
                  </span>
                </div>
              );
            })
          )}
        </ScrollArea>
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-border bg-chrome-raised px-3 py-2">
        {running ? (
          <>
            <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <StatusDot state="running" pulse />
              {SPEC.agent} is working
            </span>
            <Button size="xs" variant="destructive" className="ml-auto" onClick={onCancel}>
              <Square className="h-3 w-3" />
              Cancel
            </Button>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Hammer className="h-3 w-3" />
              {counts.files} files written
            </span>
            <Button size="xs" className="ml-auto" onClick={() => onRun(DEFAULT_PROMPT)}>
              <Play className="h-3 w-3" />
              Run phase
            </Button>
          </>
        )}
      </footer>
    </section>
  );
}
