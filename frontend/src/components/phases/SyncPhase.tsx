import { useState } from "react";
import { Check, GitBranch, Loader2, Play, RefreshCw, Square, Upload } from "lucide-react";

import { useAppStore } from "@/store/app-store";
import { api, errorMessage } from "@/lib/api";
import { PHASE_SPECS, type CommandResult } from "@/types/protocol";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SectionLabel } from "@/components/common/SectionLabel";
import { StatusDot } from "@/components/common/StatusDot";
import { toast } from "@/components/common/Toaster";
import { PHASE_RAIL } from "@/components/phases/PhaseStepper";
import { PHASE_PROMPTS } from "@/lib/phase-prompts";

const SPEC = PHASE_SPECS[4];
const DEFAULT_PROMPT = PHASE_PROMPTS.sync;
const DEFAULT_COMMIT_MESSAGE = "chore: sync verified build via Orbital";

type SyncAction = "commit" | "push" | "init" | "refresh";

function statusClass(status: string): string {
  if (status.startsWith("?")) return "text-phase-test";
  if (status.startsWith("D")) return "text-destructive";
  if (status.startsWith("A")) return "text-primary";
  return "text-muted-foreground";
}

function commandError(result: CommandResult): string | null {
  if (result.error) return result.error;
  if (result.exitCode !== 0) {
    return result.stderr.trim() || result.stdout.trim() || `git exited with code ${result.exitCode ?? "unknown"}`;
  }
  return null;
}

interface PhaseRuntimeProps {
  onRun: (prompt: string) => void;
  onCancel: () => void;
  running: boolean;
}

export function SyncPhase({ onRun, onCancel, running }: PhaseRuntimeProps) {
  const git = useAppStore((s) => s.project?.git ?? null);
  const status = useAppStore((s) => s.phaseStatus.sync);
  const setProject = useAppStore((s) => s.setProject);
  const [commitMessage, setCommitMessage] = useState(DEFAULT_COMMIT_MESSAGE);
  const [busy, setBusy] = useState<SyncAction | null>(null);

  const runGit = (action: SyncAction, task: () => Promise<CommandResult>, success: string) => {
    setBusy(action);
    void task()
      .then((result) => {
        const failure = commandError(result);
        if (failure) {
          toast.error(failure);
          return;
        }
        toast.success(success);
        return api.project().then(setProject);
      })
      .catch((err: unknown) => toast.error(errorMessage(err)))
      .finally(() => setBusy(null));
  };

  const handleCommit = () => {
    const message = commitMessage.trim();
    if (!message) {
      toast.error("Commit message cannot be empty.");
      return;
    }
    runGit("commit", () => api.gitCommit(message), "Commit created.");
  };

  const handleRefresh = () => {
    setBusy("refresh");
    void api
      .project()
      .then(setProject)
      .catch((err: unknown) => toast.error(errorMessage(err)))
      .finally(() => setBusy(null));
  };

  const synced = git !== null && git.repo && git.remote !== null && !git.dirty && git.ahead === 0 && git.behind === 0 && !git.error;

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

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 px-3 py-3">
          <div>
            <SectionLabel right={synced ? <Badge variant="success">Sync complete</Badge> : null}>Repository</SectionLabel>
            {git ? (
              <div className="border border-border">
                <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
                  <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="font-mono text-2xs text-foreground">{git.branch ?? "detached"}</span>
                  <Badge variant={git.dirty ? "warning" : "success"}>{git.dirty ? `${git.changed.length} changed` : "clean"}</Badge>
                  <span className="ml-auto font-mono text-2xs text-muted-foreground">
                    ahead {git.ahead} / behind {git.behind}
                  </span>
                </div>
                {!git.repo && <p className="border-b border-border px-2 py-1.5 text-2xs text-phase-test">Not a git repository yet.</p>}
                {git.remote === null && git.repo && (
                  <p className="border-b border-border px-2 py-1.5 text-2xs text-phase-test">No remote configured.</p>
                )}
                {git.error && <p className="border-b border-border px-2 py-1.5 text-2xs text-destructive">{git.error}</p>}
                {git.changed.length === 0 ? (
                  <p className="px-2 py-1.5 text-2xs text-muted-foreground">Working tree clean.</p>
                ) : (
                  <ul className="max-h-56 overflow-auto">
                    {git.changed.map((change) => (
                      <li key={`${change.status}-${change.path}`} className="flex items-center gap-2 border-b border-border px-2 py-1 font-mono text-2xs last:border-b-0">
                        <span className={cn("w-6 shrink-0", statusClass(change.status))}>{change.status}</span>
                        <span className="min-w-0 flex-1 truncate text-foreground">{change.path}</span>
                        {change.staged && <span className="shrink-0 text-muted-foreground">staged</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <p className="border border-border px-2 py-1.5 text-2xs text-muted-foreground">No folder open.</p>
            )}
          </div>

          <div>
            <SectionLabel>Sync actions</SectionLabel>
            <div className="flex items-center gap-2">
              <Input
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder={DEFAULT_COMMIT_MESSAGE}
                className="h-7 flex-1 font-mono text-xs"
              />
              <Button size="xs" onClick={handleCommit} disabled={busy !== null}>
                {busy === "commit" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Commit
              </Button>
              <Button size="xs" variant="secondary" onClick={() => runGit("push", () => api.gitPush(), "Push complete.")} disabled={busy !== null}>
                {busy === "push" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                Push
              </Button>
              <Button size="xs" variant="outline" onClick={() => runGit("init", () => api.gitInit(), "Repository initialised.")} disabled={busy !== null}>
                {busy === "init" ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitBranch className="h-3 w-3" />}
                Init repo
              </Button>
              <Button size="xs" variant="ghost" onClick={handleRefresh} disabled={busy !== null}>
                {busy === "refresh" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Refresh
              </Button>
            </div>
          </div>
        </div>
      </ScrollArea>

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
            <span className="text-2xs text-muted-foreground">{synced ? "Remote is up to date" : "Awaiting sync"}</span>
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
