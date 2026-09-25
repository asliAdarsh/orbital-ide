/**
 * One project, as a card in the grid or a row in the list.
 *
 * Both shapes carry the same facts — monogram, name, path, when it was last opened — so the card
 * and the row are written together: duplicating the metadata mapping would let the two views
 * drift. They also share the action menus: the control that appears on hover and the menu a
 * right-click opens render the same rows from {@link projectActions}.
 *
 * Opening is a real button stretched across the surface rather than a click handler on the
 * container: the text stays selectable, keyboard focus lands on one obvious thing, and the menus
 * can sit above it without nesting a control inside a control.
 */

import { useState } from "react";
import { MoreHorizontal, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ACTION_ICONS, projectActions, type ActionRow, type ProjectActionHandlers } from "@/components/dashboard/ProjectActions";
import { cn } from "@/lib/utils";
import type { ProjectEntry } from "@/types/protocol";

/** The pipeline's own hues, so a thumbnail never introduces a colour the app has not defined. */
const MONOGRAM_TINTS = [
  "bg-phase-plan/10 text-phase-plan",
  "bg-phase-design/10 text-phase-design",
  "bg-phase-build/10 text-phase-build",
  "bg-phase-test/10 text-phase-test",
  "bg-phase-sync/10 text-phase-sync",
] as const;

/**
 * Pick a tint from the project itself, so a card keeps its colour between sessions and no two
 * neighbours in the grid are likely to match.
 */
function monogram(project: ProjectEntry): { initials: string; tint: string } {
  const words = project.name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : project.name.slice(0, 2)).toUpperCase();
  let hash = 0;
  for (const character of project.id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return { initials, tint: MONOGRAM_TINTS[hash % MONOGRAM_TINTS.length] };
}

/** Coarse relative stamp — a launcher tile does not warrant a date library. */
export function openedLabel(lastOpenedAt: number): string {
  if (lastOpenedAt === 0) return "Not opened yet";
  const minutes = Math.round((Date.now() - lastOpenedAt * 1000) / 60_000);
  if (minutes < 1) return "Opened just now";
  if (minutes < 60) return `Opened ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Opened ${hours}h ago`;
  return `Opened ${Math.round(hours / 24)}d ago`;
}

const ROW = "flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-chrome-raised";

/**
 * One action, in whichever primitive is hosting it.
 *
 * The rows come from one list, so the only thing that differs between the hover menu and the
 * right-click menu is the element Radix expects.
 */
function MenuRow({ row, host, onDone }: { row: ActionRow; host: "popover" | "context"; onDone(): void }) {
  const Icon = ACTION_ICONS[row.icon];
  const content = (
    <>
      <Icon className="h-3 w-3" />
      {row.label}
    </>
  );

  if (host === "popover") {
    return (
      <button
        type="button"
        className={cn(ROW, row.destructive && "text-destructive hover:bg-destructive/10")}
        onClick={() => {
          onDone();
          row.onSelect();
        }}
      >
        {content}
      </button>
    );
  }

  return (
    <ContextMenuItem
      className={row.destructive ? "text-destructive data-[highlighted]:bg-destructive/10" : undefined}
      onSelect={() => row.onSelect()}
    >
      {content}
    </ContextMenuItem>
  );
}

interface ProjectMenusProps {
  project: ProjectEntry;
  /** True while the launcher is showing the recent scope, which adds one contextual action. */
  recentScope: boolean;
  handlers: ProjectActionHandlers;
  /** Which trigger this project's surface uses. */
  trigger: "hover" | "right-click";
  children?: React.ReactNode;
}

/** The shared action list, hosted by either a popover button or a right-click menu. */
function ProjectMenus({ project, recentScope, handlers, trigger, children }: ProjectMenusProps) {
  const [open, setOpen] = useState(false);
  const rows = projectActions(project, recentScope, handlers);

  if (trigger === "right-click") {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          {rows.map((row) => (
            <div key={row.key}>
              {row.separatorBefore ? <ContextMenuSeparator /> : null}
              <MenuRow row={row} host="context" onDone={() => undefined} />
            </div>
          ))}
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 bg-chrome/80 text-muted-foreground backdrop-blur-sm hover:text-foreground"
          aria-label={`Actions for ${project.name}`}
          title="Actions"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-1">
        {rows.map((row) => (
          <div key={row.key}>
            {row.separatorBefore ? <div className="my-1 h-px bg-border" /> : null}
            <MenuRow row={row} host="popover" onDone={() => setOpen(false)} />
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export interface ProjectCardProps {
  project: ProjectEntry;
  recentScope: boolean;
  onOpen(project: ProjectEntry): void;
  handlers: ProjectActionHandlers;
}

/** The grid shape: a thumbnail block over the name, the description and the path. */
export function ProjectCard({ project, recentScope, onOpen, handlers }: ProjectCardProps) {
  const { initials, tint } = monogram(project);

  return (
    <ProjectMenus project={project} recentScope={recentScope} handlers={handlers} trigger="right-click">
      <li className="group relative animate-fade-in overflow-hidden rounded border border-border bg-chrome focus-within:border-primary/50 hover:border-primary/40">
        <button
          type="button"
          onClick={() => onOpen(project)}
          aria-label={`Open ${project.name}`}
          className="absolute inset-0 z-0 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary"
        />
        <div className={cn("pointer-events-none flex aspect-[4/3] items-center justify-center border-b border-border", tint)}>
          <span className="font-mono text-xl tracking-[0.2em]">{initials}</span>
        </div>
        <div className="pointer-events-none flex flex-col gap-0.5 px-3 py-2">
          <span className="flex items-center gap-1.5 truncate text-xs font-medium text-foreground">
            <span className="truncate">{project.name}</span>
            {project.favourite ? (
              <Star aria-label="Favourite" className="h-3 w-3 shrink-0 fill-primary text-primary" />
            ) : null}
          </span>
          {project.description ? (
            <span className="truncate text-2xs text-muted-foreground">{project.description}</span>
          ) : null}
          <span className="truncate font-mono text-2xs text-muted-foreground/80" title={project.path}>
            {project.path}
          </span>
          <span className="text-2xs text-muted-foreground/70">{openedLabel(project.lastOpenedAt)}</span>
        </div>
        <div className="absolute right-1.5 top-1.5 z-10 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <ProjectMenus project={project} recentScope={recentScope} handlers={handlers} trigger="hover" />
        </div>
      </li>
    </ProjectMenus>
  );
}

/** The list shape: same facts on one line, for when the grid is too coarse. */
export function ProjectRow({ project, recentScope, onOpen, handlers }: ProjectCardProps) {
  const { initials, tint } = monogram(project);

  return (
    <ProjectMenus project={project} recentScope={recentScope} handlers={handlers} trigger="right-click">
      <li className="relative flex animate-fade-in items-center gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-chrome-raised focus-within:bg-chrome-raised">
        <button
          type="button"
          onClick={() => onOpen(project)}
          aria-label={`Open ${project.name}`}
          className="absolute inset-0 z-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary"
        />
        <span
          aria-hidden
          className={cn("pointer-events-none flex h-7 w-7 shrink-0 items-center justify-center rounded font-mono text-2xs", tint)}
        >
          {initials}
        </span>
        <span className="pointer-events-none flex w-40 shrink-0 items-center gap-1.5 text-xs text-foreground">
          <span className="truncate">{project.name}</span>
          {project.favourite ? (
            <Star aria-label="Favourite" className="h-3 w-3 shrink-0 fill-primary text-primary" />
          ) : null}
        </span>
        <span className="pointer-events-none min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground" title={project.path}>
          {project.path}
        </span>
        <span className="pointer-events-none hidden min-w-0 flex-1 truncate text-2xs text-muted-foreground lg:block">
          {project.description ?? ""}
        </span>
        <span className="pointer-events-none shrink-0 text-2xs text-muted-foreground/70">
          {openedLabel(project.lastOpenedAt)}
        </span>
        <div className="relative z-10">
          <ProjectMenus project={project} recentScope={recentScope} handlers={handlers} trigger="hover" />
        </div>
      </li>
    </ProjectMenus>
  );
}
