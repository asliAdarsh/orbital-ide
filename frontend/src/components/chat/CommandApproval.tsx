import { Check, FolderOpen, ShieldAlert, X, type LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ApprovalCard } from "@/store/app-store";
import type { AgentId, Phase } from "@/types/protocol";

export interface CommandApprovalProps {
  /** The held command plus the decision, if the user has already made one. */
  request: ApprovalCard;
  /** `remember` allows every later command in this run without another prompt. */
  onDecide: (approved: boolean, remember: boolean) => void;
}

/** Same identity as the chat chip: the phase hue is what the agent looks like everywhere. */
const AGENT_PHASE: Record<AgentId, Phase> = {
  orchestrator: "plan",
  architect: "design",
  code_engine: "build",
  qa: "test",
};

const AGENT_LABEL: Record<AgentId, string> = {
  orchestrator: "Orchestrator",
  architect: "Architect",
  code_engine: "Code Engine",
  qa: "QA",
};

/**
 * How a card reads once it has an answer. Settled cards drop the buttons entirely so they
 * cannot be mistaken for a gate that still needs one.
 */
const ANSWERED: Record<
  "approved" | "denied",
  { frame: string; tone: string; label: string; note: string; icon: LucideIcon }
> = {
  approved: {
    frame: "border-primary/40",
    tone: "text-primary",
    label: "Allowed",
    note: "Allowed — the agent runs this on your machine.",
    icon: Check,
  },
  denied: {
    frame: "border-destructive/40",
    tone: "text-destructive",
    label: "Denied",
    note: "Denied — this command was not run.",
    icon: X,
  },
};

export function CommandApproval({ request, onDecide }: CommandApprovalProps) {
  const answered = request.decided === null ? null : ANSWERED[request.decided];

  return (
    <div
      className={cn(
        "rounded border bg-card text-2xs",
        answered ? answered.frame : "border-border",
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <ShieldAlert className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <Badge variant="phase" phase={AGENT_PHASE[request.agent]}>
          {AGENT_LABEL[request.agent]}
        </Badge>
        <span className="text-muted-foreground">{request.phase}</span>
        <span
          className="ml-auto min-w-0 truncate font-mono text-muted-foreground"
          title={request.tool}
        >
          {request.tool}
        </span>
      </div>

      <div className="space-y-1.5 p-2">
        <p className="text-muted-foreground">
          {answered ? answered.note : "The agent is waiting to run this on your machine."}
        </p>
        <pre className="whitespace-pre-wrap break-all rounded border border-border bg-chrome-sunken p-2 font-mono text-2xs text-foreground">
          {request.command}
        </pre>
        <div className="flex items-center gap-1.5 text-muted-foreground" title={request.cwd}>
          <FolderOpen className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate font-mono">{request.cwd}</span>
        </div>
      </div>

      {answered ? (
        <div
          className={cn(
            "flex items-center gap-1.5 border-t border-border px-2 py-1.5 font-medium",
            answered.tone,
          )}
        >
          <answered.icon className="size-3 shrink-0" aria-hidden />
          {answered.label}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 border-t border-border px-2 py-1.5">
          <Button size="xs" onClick={() => onDecide(true, false)}>
            <Check className="size-3" />
            Allow
          </Button>
          <Button
            size="xs"
            variant="secondary"
            title="Allow this command and every later one in this run — no further prompts until it ends."
            onClick={() => onDecide(true, true)}
          >
            Allow all in this run
          </Button>
          <Button
            className="ml-auto"
            size="xs"
            variant="destructive"
            onClick={() => onDecide(false, false)}
          >
            <X className="size-3" />
            Deny
          </Button>
        </div>
      )}
    </div>
  );
}
