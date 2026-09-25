import { cn } from "@/lib/utils";
import { PHASE_SPECS, type Phase, type PhaseStatus } from "@/types/protocol";
import { StatusDot } from "@/components/common/StatusDot";

/** Rail fill per phase — also consumed by the phase headers so the pipeline reads consistently. */
export const PHASE_RAIL: Record<Phase, string> = {
  plan: "bg-phase-plan",
  design: "bg-phase-design",
  build: "bg-phase-build",
  test: "bg-phase-test",
  sync: "bg-phase-sync",
};

export interface PhaseStepperProps {
  activePhase: Phase;
  status: Record<Phase, PhaseStatus>;
  onSelect: (phase: Phase) => void;
}

export function PhaseStepper({ activePhase, status, onSelect }: PhaseStepperProps) {
  return (
    <nav aria-label="Pipeline phases" className="flex flex-col">
      {PHASE_SPECS.map((info) => {
        const active = info.id === activePhase;
        return (
          <button
            key={info.id}
            type="button"
            onClick={() => onSelect(info.id)}
            aria-current={active ? "step" : undefined}
            className={cn(
              "relative flex w-full items-center gap-2 border-b border-border py-1.5 pl-3 pr-2 text-left",
              active ? "bg-chrome-raised" : "hover:bg-chrome-raised",
            )}
          >
            <span className={cn("absolute inset-y-0 left-0 w-0.5", active ? PHASE_RAIL[info.id] : "bg-border")} />
            <span className="flex h-5 w-5 shrink-0 items-center justify-center border border-border bg-chrome-sunken font-mono text-2xs text-muted-foreground">
              {info.index}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-foreground">{info.title}</span>
              <span className="block truncate font-mono text-2xs text-muted-foreground">{info.agent}</span>
            </span>
            <StatusDot state={status[info.id]} />
          </button>
        );
      })}
    </nav>
  );
}
