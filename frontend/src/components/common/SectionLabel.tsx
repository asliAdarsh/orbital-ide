import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SectionLabelProps {
  children: ReactNode;
  right?: ReactNode;
  className?: string;
}

export function SectionLabel({ children, right, className }: SectionLabelProps) {
  return (
    <div
      className={cn(
        "flex h-7 items-center justify-between gap-2 px-2 text-2xs font-medium uppercase tracking-wider text-muted-foreground",
        className,
      )}
    >
      <span className="truncate">{children}</span>
      {right ? <span className="flex shrink-0 items-center gap-1">{right}</span> : null}
    </div>
  );
}
