import type { PhaseStatus, RunStatus } from "@/types/protocol";

import { cn } from "@/lib/utils";

export type StatusDotState = PhaseStatus | RunStatus | "online" | "offline";

const stateClass: Record<StatusDotState, string> = {
  idle: "bg-muted-foreground/50",
  queued: "bg-muted-foreground/50",
  cancelled: "bg-muted-foreground/50",
  offline: "bg-muted-foreground/50",
  running: "bg-primary animate-rail-pulse",
  online: "bg-primary",
  done: "bg-primary/70",
  error: "bg-destructive",
};

export interface StatusDotProps {
  state: StatusDotState;
  className?: string;
  pulse?: boolean;
}

export function StatusDot({ state, className, pulse = false }: StatusDotProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        stateClass[state],
        pulse && "animate-rail-pulse",
        className,
      )}
    />
  );
}
