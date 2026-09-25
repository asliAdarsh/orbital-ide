import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, hint, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center",
        className,
      )}
    >
      <Icon className="h-5 w-5 text-muted-foreground/60" strokeWidth={1.5} aria-hidden />
      <p className="text-xs font-medium text-foreground">{title}</p>
      {hint ? <p className="max-w-xs text-2xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      {action}
    </div>
  );
}
