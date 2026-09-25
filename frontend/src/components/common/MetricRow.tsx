import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface MetricRowProps {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
  className?: string;
}

export function MetricRow({ label, value, mono = false, className }: MetricRowProps) {
  return (
    <div className={cn("flex h-6 items-center justify-between gap-3 text-2xs", className)}>
      <span className="truncate text-muted-foreground">{label}</span>
      <span className={cn("shrink-0 truncate tabular-nums text-foreground", mono && "font-mono")}>
        {value}
      </span>
    </div>
  );
}
