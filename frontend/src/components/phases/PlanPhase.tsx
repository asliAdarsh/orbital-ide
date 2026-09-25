import { useState } from "react";
import { Check, MessagesSquare, Send, Square } from "lucide-react";

import { useAgentSocket } from "@/hooks/useAgentSocket";
import { useAppStore } from "@/store/app-store";
import { Markdown } from "@/components/common/Markdown";
import { PHASE_SPECS, type PhaseInfo } from "@/types/protocol";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { StatusDot } from "@/components/common/StatusDot";
import { PHASE_RAIL } from "@/components/phases/PhaseStepper";

const SPEC = PHASE_SPECS[0];
const ARTIFACT = SPEC.deliverable;

interface PhaseRuntimeProps {
  onRun: (prompt: string) => void;
  onCancel: () => void;
  running: boolean;
  /** The phase a confirmation moves on to, when there is one. */
  nextPhase: PhaseInfo | null;
  /** Starts that phase. Null when this is the last one. */
  onAdvance: (() => void) | null;
}

export function PlanPhase({ onCancel, running, nextPhase, onAdvance }: PhaseRuntimeProps) {
  const artifact = useAppStore((s) => s.artifacts[ARTIFACT]);
  const status = useAppStore((s) => s.phaseStatus.plan);
  const projectPath = useAppStore((s) => s.project?.projectPath ?? null);
  const [message, setMessage] = useState("");
  const socket = useAgentSocket();

  const canSend = message.trim().length > 0 && projectPath !== null && !running;

  const send = () => {
    const text = message.trim();
    if (!text || !projectPath) return;
    socket.chat("plan", text, projectPath);
    setMessage("");
  };

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

      {artifact ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-4 py-3">
            <Markdown>{artifact}</Markdown>
          </div>
        </ScrollArea>
      ) : (
        // Nothing is written until the plan is agreed, so the canvas is a place to talk rather
        // than a place to type a prompt and hope. The transcript lives in the chat panel; this is
        // the composer for it, in the surface the user is already looking at.
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <div className="w-full max-w-lg space-y-2">
            <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <MessagesSquare className="h-3.5 w-3.5" />
              Talk it through with the {SPEC.agent} — they write {ARTIFACT} when they have heard
              enough. The conversation appears in the chat panel.
            </div>
            <div className="flex items-end gap-2">
              <Textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
                rows={3}
                autoFocus
                placeholder="What are you building?"
                className="font-mono text-xs"
              />
              <Button size="sm" onClick={send} disabled={!canSend}>
                <Send className="h-3.5 w-3.5" />
                Send
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Nothing to run and nothing to confirm until the architect has written the plan: this
          phase is a conversation, and the controls for leaving it appear with the thing they act
          on. */}
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
        ) : artifact ? (
          <>
            <span className="text-2xs text-muted-foreground">
              {ARTIFACT} ready — read it, ask for changes in the chat, then confirm.
            </span>
            {nextPhase && onAdvance ? (
              <Button size="xs" className="ml-auto" onClick={onAdvance}>
                <Check className="h-3 w-3" />
                Plan looks right → {nextPhase.title}
              </Button>
            ) : null}
          </>
        ) : (
          <span className="text-2xs text-muted-foreground">
            Talking it through — the architect writes {ARTIFACT} here once you have agreed on it, and
            revises it whenever you ask.
          </span>
        )}
      </footer>
    </section>
  );
}
