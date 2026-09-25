import { useState } from "react";
import { Check, Shield, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";
import type { PermissionMode } from "@/types/protocol";

/** The two settings, in the order the popover offers them. */
const PERMISSION_ORDER: readonly PermissionMode[] = ["ask", "allow_all"];

const PERMISSION_COPY: Record<
  PermissionMode,
  { short: string; title: string; label: string; detail: string }
> = {
  ask: {
    short: "Ask",
    title: "Permission: ask for approval on every command",
    label: "Default permission — ask for approval",
    detail: "Every command the agent wants to run waits for your decision on a card.",
  },
  allow_all: {
    short: "Allow all",
    title: "Permission: run commands without asking",
    label: "Allow all",
    detail: "Commands run without asking, for the rest of this session.",
  },
};

/**
 * The approval control for the composer toolbar.
 *
 * Two settings, not a spectrum: the agent either holds every command for a card or runs them
 * unattended. The choice is a session setting — it outlives a run — which is why it lives in the
 * store rather than on the approval card, whose "allow all in this run" is cleared when the run
 * ends.
 */
export function PermissionPicker() {
  const permission = useAppStore((s) => s.permission);
  const setPermission = useAppStore((s) => s.setPermission);
  const [open, setOpen] = useState(false);
  const current = PERMISSION_COPY[permission];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant="outline"
          aria-label={`Permission: ${current.short}`}
          title={current.title}
          className={cn("shrink-0 gap-1", permission === "allow_all" && "text-primary")}
        >
          {permission === "allow_all" ? (
            <ShieldCheck className="size-3 shrink-0" />
          ) : (
            <Shield className="size-3 shrink-0" />
          )}
          {current.short}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        <div role="radiogroup" aria-label="Permission">
          {PERMISSION_ORDER.map((id) => {
            const option = PERMISSION_COPY[id];
            const selected = permission === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  setPermission(id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-start gap-1.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-chrome-raised",
                  selected ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <Check className={cn("mt-0.5 size-3 shrink-0", selected ? "opacity-100" : "opacity-0")} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{option.label}</span>
                  <span className="text-muted-foreground">{option.detail}</span>
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
