import { AlertTriangle, CheckCircle2, Plus, Terminal, X } from "lucide-react";

import { useAppStore, type LogLevel, type TerminalEntry } from "@/store/app-store";
import { useAgentSocket } from "@/hooks/useAgentSocket";
import { usePanelSize } from "@/hooks/usePanelSize";
import { cn, formatDuration } from "@/lib/utils";
import type { ToolResult } from "@/types/protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/common/EmptyState";
import { StatusDot } from "@/components/common/StatusDot";
import { TerminalPanel } from "@/components/terminal/TerminalPanel";

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 640;
const DEFAULT_HEIGHT = 220;
const MAX_LOG_ROWS = 500;
const MAX_PROBLEM_ROWS = 50;
const MAX_EXIT_ROWS = 50;

/** A tab with no history shares one identity, so the panel's replay effect does not refire per render. */
const NO_ENTRIES: TerminalEntry[] = [];

const LOG_LEVEL_CLASS: Record<LogLevel, string> = {
  debug: "text-muted-foreground",
  info: "text-foreground",
  warn: "text-phase-test",
  error: "text-destructive",
};

export function BottomPanel() {
  const terminals = useAppStore((s) => s.terminals);
  const activeTerminalId = useAppStore((s) => s.activeTerminalId);
  const activeCommandId = useAppStore((s) => s.activeCommandId);
  const projectPath = useAppStore((s) => s.project?.projectPath ?? "");
  const addTerminal = useAppStore((s) => s.addTerminal);
  const closeTerminal = useAppStore((s) => s.closeTerminal);
  const setActiveTerminal = useAppStore((s) => s.setActiveTerminal);
  const logs = useAppStore((s) => s.logs);
  const toolCalls = useAppStore((s) => s.toolCalls);
  const toolResults = useAppStore((s) => s.toolResults);
  const runError = useAppStore((s) => s.runError);
  const socket = useAgentSocket();

  const { size: height, handleProps } = usePanelSize({
    storageKey: "orbital.bottomPanelHeight",
    initial: DEFAULT_HEIGHT,
    min: MIN_HEIGHT,
    max: MAX_HEIGHT,
    grow: "up",
    label: "bottom panel",
  });

  const failures = toolCalls
    .map((call) => toolResults[call.id])
    .filter((result): result is ToolResult => result !== undefined && !result.ok)
    .slice(0, MAX_PROBLEM_ROWS);
  const recentLogs = logs.slice(-MAX_LOG_ROWS);
  // Every shell's transcript feeds one list: the Output tab is not per-terminal.
  const commandExits = terminals
    .flatMap((tab) => tab.transcript)
    .filter((entry) => entry.result !== null)
    .slice(-MAX_EXIT_ROWS);
  const activeTab = terminals.find((tab) => tab.id === activeTerminalId);
  const runningTabId = activeCommandId
    ? terminals.find((tab) => tab.transcript.some((entry) => entry.id === activeCommandId))?.id ?? null
    : null;

  return (
    <section style={{ height }} className="flex shrink-0 flex-col border-t border-border bg-chrome">
      <div
        {...handleProps}
        className="group flex h-1.5 shrink-0 cursor-row-resize items-center justify-center bg-chrome"
      >
        <span className="h-px w-10 bg-border group-hover:bg-primary" />
      </div>

      <Tabs defaultValue="terminal" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="shrink-0">
          <TabsTrigger value="terminal">Terminal</TabsTrigger>
          <TabsTrigger value="problems">
            Problems
            {failures.length > 0 && <span className="ml-1 font-mono text-2xs text-destructive">{failures.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="output">Output</TabsTrigger>
        </TabsList>

        <TabsContent value="terminal" className="min-h-0 flex-1">
          {terminals.length === 0 ? (
            <EmptyState
              icon={Terminal}
              title="No terminals"
              hint="Open a shell to run commands against the workspace."
              action={
                <Button size="xs" onClick={() => addTerminal(projectPath)}>
                  <Plus className="size-3" />
                  Add terminal
                </Button>
              }
            />
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-6 shrink-0 items-stretch overflow-x-auto border-b border-border bg-chrome">
                {terminals.map((tab) => {
                  const isActive = tab.id === activeTerminalId;
                  return (
                    <div
                      key={tab.id}
                      className={cn(
                        "group relative flex shrink-0 items-stretch border-r border-border",
                        isActive ? "bg-chrome-sunken" : "bg-chrome hover:bg-chrome-raised",
                      )}
                    >
                      {isActive ? <span className="absolute inset-x-0 top-0 h-px bg-primary" /> : null}
                      <button
                        type="button"
                        title={tab.cwd || tab.title}
                        onClick={() => setActiveTerminal(tab.id)}
                        className={cn(
                          "flex min-w-0 max-w-[200px] items-center gap-1.5 pl-2 text-2xs",
                          isActive ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        <span className="truncate">{tab.title}</span>
                        {tab.id === runningTabId ? <StatusDot state="running" /> : null}
                      </button>
                      <button
                        type="button"
                        title="close"
                        aria-label={`Close ${tab.title}`}
                        onClick={() => closeTerminal(tab.id)}
                        className="flex w-6 items-center justify-center text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  );
                })}
                <button
                  type="button"
                  title="new terminal"
                  aria-label="New terminal"
                  onClick={() => addTerminal(projectPath)}
                  className="sticky right-0 flex w-6 shrink-0 items-center justify-center bg-chrome text-muted-foreground hover:bg-chrome-raised hover:text-foreground"
                >
                  <Plus className="size-3" />
                </button>
              </div>
              {/*
                The `key` is load-bearing: xterm owns a single buffer, so switching shells has to
                remount the panel. Without it every shell writes into one scrollback.
              */}
              <TerminalPanel
                key={activeTerminalId}
                onExec={socket.exec}
                onCancel={socket.cancel}
                entries={activeTab?.transcript ?? NO_ENTRIES}
                activeId={activeCommandId}
                className="min-h-0 flex-1"
              />
            </div>
          )}
        </TabsContent>

        <TabsContent value="problems" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            {runError && (
              <div className="flex items-start gap-2 border-b border-border px-3 py-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                <span className="min-w-0 flex-1 break-words font-mono text-2xs text-destructive">{runError}</span>
              </div>
            )}
            {failures.length === 0 && !runError ? (
              <EmptyState icon={CheckCircle2} title="No problems" hint="Failed tool calls and run errors are listed here." />
            ) : (
              failures.map((failure) => (
                <div key={failure.id} className="border-b border-border px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="danger">{failure.name}</Badge>
                    <span className="font-mono text-2xs text-muted-foreground">{formatDuration(failure.durationMs)}</span>
                    {failure.truncated && <span className="text-2xs text-phase-test">output clipped</span>}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words font-mono text-2xs text-muted-foreground">
                    {failure.error ?? failure.output}
                  </p>
                </div>
              ))
            )}
          </ScrollArea>
        </TabsContent>

        <TabsContent value="output" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            {recentLogs.length === 0 ? (
              <p className="px-3 py-2 text-2xs text-muted-foreground">No output yet.</p>
            ) : (
              recentLogs.map((entry, index) => (
                <div
                  key={`log-${entry.ts}-${index}`}
                  className={cn("flex gap-2 border-b border-border px-3 py-1 font-mono text-2xs", LOG_LEVEL_CLASS[entry.level])}
                >
                  <span className="shrink-0 text-muted-foreground">{new Date(entry.ts).toLocaleTimeString()}</span>
                  <span className="min-w-0 break-words">{entry.message}</span>
                </div>
              ))
            )}
            {commandExits.length > 0 && (
              <>
                <div className="sticky top-0 border-b border-border bg-chrome-raised px-3 py-1 font-mono text-2xs uppercase tracking-wider text-muted-foreground">
                  Command exits
                </div>
                {commandExits.map((entry) => (
                  <div key={`exit-${entry.id}`} className="flex items-center gap-2 border-b border-border px-3 py-1 font-mono text-2xs">
                    <span className={entry.result?.exitCode === 0 ? "text-primary" : "text-destructive"}>
                      exit {entry.result?.exitCode ?? "?"}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.command}</span>
                    <span className="shrink-0 text-muted-foreground">{formatDuration(entry.result?.durationMs ?? 0)}</span>
                  </div>
                ))}
              </>
            )}
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </section>
  );
}
