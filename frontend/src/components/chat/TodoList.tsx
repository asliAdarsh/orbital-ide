import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Circle, ListChecks, Loader2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TodoItem, TodoStatus } from "@/types/protocol";

/** One status, one icon and one hue — the row's meaning has to survive a glance. */
const STATUS_STYLE: Record<TodoStatus, { icon: LucideIcon; tone: string; label: string }> = {
  pending: { icon: Circle, tone: "text-muted-foreground", label: "pending" },
  in_progress: { icon: Loader2, tone: "text-accent", label: "in progress" },
  completed: { icon: CheckCircle2, tone: "text-primary", label: "completed" },
};

export interface TodoListProps {
  /** The agent's list as last published; the newest frame replaces it whole. */
  items: TodoItem[];
  /**
   * Whether a run is in flight. The panel is mounted per run — the store empties the list when one
   * starts — so this is only the first state: open while the agent is working, collapsed once the
   * list is a record of finished work. A user's own toggle is never overridden.
   */
  running: boolean;
  className?: string;
}

/**
 * The agent's working list, collapsed to a one-line summary until it is unfolded.
 *
 * Both dimensions are capped: the header row is fixed height and the rows scroll, so a twenty-item
 * list costs the transcript a few rows rather than the whole pane.
 */
export function TodoList({ items, running, className }: TodoListProps) {
  const [open, setOpen] = useState(running);
  const done = items.filter((item) => item.status === "completed").length;

  return (
    <div className={cn("shrink-0 rounded border border-border bg-chrome-sunken", className)}>
      <button
        type="button"
        aria-expanded={open}
        // The composer's draft is what the user is working in; unfolding a list should not move
        // focus out of it. Keyboard focus still reaches the header.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-2xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="size-3 shrink-0" aria-hidden />
        )}
        <ListChecks className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">Agent working list</span>
        <Badge variant={done === items.length ? "success" : "secondary"}>
          {done}/{items.length} done
        </Badge>
      </button>
      {open ? (
        <ul className="max-h-40 overflow-y-auto border-t border-border py-1">
          {items.map((item, index) => {
            const status = STATUS_STYLE[item.status];
            const Icon = status.icon;
            return (
              <li
                // Rows have no id on the wire: content and position are what identifies one.
                key={`${index}-${item.content}`}
                className="flex items-start gap-1.5 px-2 py-0.5 text-2xs"
              >
                <Icon
                  className={cn(
                    "mt-px size-3 shrink-0",
                    status.tone,
                    // A spinner that outlives its run would claim work is happening when it is not.
                    item.status === "in_progress" && running && "animate-spin",
                  )}
                  aria-hidden
                />
                <span className="sr-only">{status.label}</span>
                <span
                  className={cn(
                    "min-w-0 break-words",
                    item.status === "completed" && "text-muted-foreground line-through",
                  )}
                >
                  {item.content}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
