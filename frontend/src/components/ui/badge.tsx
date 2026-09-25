import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex select-none items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-2xs font-medium leading-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-chrome-raised text-foreground",
        outline: "border-border text-muted-foreground",
        success: "border-transparent bg-primary/15 text-primary",
        warning: "border-transparent bg-phase-test/15 text-phase-test",
        danger: "border-transparent bg-destructive/15 text-destructive",
        phase: "border-transparent",
      },
      phase: {
        plan: "bg-phase-plan/15 text-phase-plan",
        design: "bg-phase-design/15 text-phase-design",
        build: "bg-phase-build/15 text-phase-build",
        test: "bg-phase-test/15 text-phase-test",
        sync: "bg-phase-sync/15 text-phase-sync",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>;

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, phase, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(badgeVariants({ variant, phase: variant === "phase" ? phase : null }), className)}
      {...props}
    />
  ),
);
Badge.displayName = "Badge";
