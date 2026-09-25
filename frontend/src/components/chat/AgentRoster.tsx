import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { PHASE_SPECS, type AgentId, type Phase } from "@/types/protocol";

export interface AgentRosterProps {
  activeAgent: AgentId;
  phase: Phase;
}

const ROSTER: { id: AgentId; label: string; caption: string }[] = [
  { id: "orchestrator", label: "Orchestrator", caption: "Supervises all phases" },
  { id: "architect", label: "Architect", caption: "Phase 1 & 2" },
  { id: "code_engine", label: "Code Engine", caption: "Phase 3 & 5" },
  { id: "qa", label: "QA", caption: "Phase 4" },
];

export function AgentRoster({ activeAgent, phase }: AgentRosterProps) {
  const owner = PHASE_SPECS.find((spec) => spec.id === phase)?.agent;

  return (
    <div className="relative py-1">
      <span aria-hidden className="absolute bottom-4 left-[10px] top-4 w-px bg-border" />
      {ROSTER.map((agent) => {
        const isActive = agent.id === activeAgent;
        return (
          <div
            key={agent.id}
            className={cn(
              "relative flex items-center gap-2 py-1 pl-1.5 pr-2 text-2xs",
              isActive ? "rounded bg-primary/10 text-foreground" : "text-muted-foreground opacity-50",
            )}
          >
            <span
              className={cn(
                "relative z-10 size-2 shrink-0 rounded-full",
                isActive ? "bg-primary" : "bg-muted-foreground",
              )}
            />
            <span className="shrink-0 font-medium">{agent.label}</span>
            <span className="min-w-0 flex-1 truncate">{agent.caption}</span>
            {owner === agent.id ? (
              <Badge variant="phase" phase={phase}>
                {phase}
              </Badge>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
