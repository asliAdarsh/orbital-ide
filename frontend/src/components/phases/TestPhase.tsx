import { useMemo } from "react";
import { AlertTriangle, FlaskConical, Play, Square } from "lucide-react";

import { useAppStore } from "@/store/app-store";
import { PHASE_SPECS } from "@/types/protocol";
import { cn, formatDuration } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/common/EmptyState";
import { SectionLabel } from "@/components/common/SectionLabel";
import { StatusDot } from "@/components/common/StatusDot";
import { PHASE_RAIL } from "@/components/phases/PhaseStepper";
import { PHASE_PROMPTS } from "@/lib/phase-prompts";

const SPEC = PHASE_SPECS[3];
const DEFAULT_PROMPT = PHASE_PROMPTS.test;
const TEST_TOOLS = ["run_tests", "run_command"];
/** Matches `path/to/file.ext:line` (optionally `:col`) inside runner output. */
const FAILURE_SITE = /(?:^|\s)([A-Za-z0-9_@./\\-]+\.[A-Za-z0-9]+):(\d+)(?::\d+)?/g;

function extractFailureSites(output: string): string[] {
  const sites = new Set<string>();
  for (const match of output.matchAll(FAILURE_SITE)) {
    sites.add(`${match[1]}:${match[2]}`);
  }
  return [...sites].slice(0, 100);
}

interface PhaseRuntimeProps {
  onRun: (prompt: string) => void;
  onCancel: () => void;
  running: boolean;
}

export function TestPhase({ onRun, onCancel, running }: PhaseRuntimeProps) {
  const toolCalls = useAppStore((s) => s.toolCalls);
  const toolResults = useAppStore((s) => s.toolResults);
  const status = useAppStore((s) => s.phaseStatus.test);

  const latest = toolCalls.find((call) => TEST_TOOLS.includes(call.name) && toolResults[call.id] !== undefined);
  const result = latest ? toolResults[latest.id] : null;
  const failures = useMemo(
    () => (result ? extractFailureSites(`${result.output}\n${result.error ?? ""}`) : []),
    [result],
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

      {result ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 px-3 py-3">
            <div className="flex items-center gap-2">
              <Badge variant={result.ok ? "success" : "danger"}>{result.ok ? "passed" : "failed"}</Badge>
              <span className="font-mono text-2xs text-foreground">{latest?.name}</span>
              <span className="font-mono text-2xs text-muted-foreground">{formatDuration(result.durationMs)}</span>
              {result.truncated && <span className="text-2xs text-phase-test">output clipped</span>}
            </div>

            <div>
              <SectionLabel right={<span className="font-mono text-2xs text-muted-foreground">{failures.length}</span>}>
                Failing sites
              </SectionLabel>
              {failures.length === 0 ? (
                <p className="border border-border px-2 py-1.5 text-2xs text-muted-foreground">
                  No file:line failures matched in the runner output.
                </p>
              ) : (
                <ul className="divide-y divide-border border border-border">
                  {failures.map((site) => (
                    <li key={site} className="flex items-center gap-2 px-2 py-1 font-mono text-2xs text-destructive">
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      <span className="truncate">{site}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <SectionLabel>Raw output</SectionLabel>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap border border-border bg-chrome-sunken p-2 font-mono text-2xs text-muted-foreground">
                {result.output || result.error || "(no output)"}
              </pre>
            </div>
          </div>
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <EmptyState
            icon={FlaskConical}
            title="No test run yet"
            hint={SPEC.description}
            action={
              <Button size="sm" onClick={() => onRun(DEFAULT_PROMPT)} disabled={running}>
                <Play className="h-3.5 w-3.5" />
                Re-run tests
              </Button>
            }
          />
        </div>
      )}

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
            <span className="text-2xs text-muted-foreground">{result ? "Latest runner output above" : "Awaiting run"}</span>
            <Button size="xs" className="ml-auto" onClick={() => onRun(DEFAULT_PROMPT)}>
              <Play className="h-3 w-3" />
              Re-run tests
            </Button>
          </>
        )}
      </footer>
    </section>
  );
}
