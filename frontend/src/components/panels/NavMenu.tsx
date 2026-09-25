/**
 * Dropdown menu for the nav bar, built on the shared popover primitive.
 *
 * `PopoverClose` is imported from the Radix package rather than re-exported through
 * `@/components/ui/popover` because that module only surfaces Root/Trigger/Content; selecting
 * an item has to dismiss the menu, and Radix already owns that behaviour.
 */

import type { ReactNode } from "react";
import { Close as PopoverClose } from "@radix-ui/react-popover";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface NavMenuButtonProps {
  label: string;
  children: ReactNode;
}

/** Text trigger for the nav bar. The popover is uncontrolled; Radix owns open/close. */
export function NavMenuButton({ label, children }: NavMenuButtonProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          className="h-[18px] px-1.5 text-2xs data-[state=open]:bg-chrome-raised data-[state=open]:text-foreground"
        >
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-56 p-1"
        // Menus that trigger dialogs and store actions must not yank focus back to the trigger.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

export interface NavMenuItemProps {
  icon: LucideIcon;
  label: string;
  /** Right-aligned dimmed accelerator, e.g. `Ctrl/Cmd + S`. */
  hint?: string;
  onSelect: () => void;
  destructive?: boolean;
}

export function NavMenuItem({
  icon: Icon,
  label,
  hint,
  onSelect,
  destructive = false,
}: NavMenuItemProps) {
  return (
    <PopoverClose asChild>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex h-6 w-full items-center gap-2 rounded px-1.5 text-left text-2xs transition-colors hover:bg-chrome-raised",
          destructive ? "text-destructive" : "text-foreground",
        )}
      >
        <Icon aria-hidden className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {hint && <span className="shrink-0 font-mono text-muted-foreground/70">{hint}</span>}
      </button>
    </PopoverClose>
  );
}
