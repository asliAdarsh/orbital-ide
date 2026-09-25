/**
 * The actions one project offers, written once for the two menus that offer them.
 *
 * A desktop user reaches for right-click; a pointer user reaches for the control that appears on
 * hover. Those are different primitives — a context menu and a popover — but they must not become
 * different action lists, so the list lives here and each menu supplies the element that renders
 * one row. Adding an action therefore adds it to both.
 */

import { Clock, FolderOpen, Pencil, Star, StarOff, Trash2 } from "lucide-react";

import type { ProjectEntry } from "@/types/protocol";

/** One row, described rather than rendered, so either menu can draw it. */
export interface ActionRow {
  key: string;
  label: string;
  icon: "open" | "edit" | "favourite" | "unfavourite" | "recent" | "delete";
  onSelect(): void;
  /** Separates this row from the ones above it. */
  separatorBefore?: boolean;
  destructive?: boolean;
}

export interface ProjectActionHandlers {
  onOpen(project: ProjectEntry): void;
  onEdit(project: ProjectEntry): void;
  onToggleFavourite(project: ProjectEntry): void;
  onClearRecent(project: ProjectEntry): void;
  onDelete(project: ProjectEntry): void;
}

/** The icon each row draws, keyed by the row's icon name. */
export const ACTION_ICONS = {
  open: FolderOpen,
  edit: Pencil,
  favourite: Star,
  unfavourite: StarOff,
  recent: Clock,
  delete: Trash2,
} as const;

/**
 * The rows for one project.
 *
 * `recentScope` controls the single contextual entry: forgetting that a project was opened only
 * means something while looking at the list of recently opened ones.
 */
export function projectActions(
  project: ProjectEntry,
  recentScope: boolean,
  handlers: ProjectActionHandlers,
): ActionRow[] {
  const rows: ActionRow[] = [
    { key: "open", label: "Open", icon: "open", onSelect: () => handlers.onOpen(project) },
    {
      key: "edit",
      label: "Edit project…",
      icon: "edit",
      onSelect: () => handlers.onEdit(project),
    },
    {
      key: "favourite",
      label: project.favourite ? "Remove from favourites" : "Add to favourites",
      icon: project.favourite ? "unfavourite" : "favourite",
      onSelect: () => handlers.onToggleFavourite(project),
    },
  ];

  if (recentScope) {
    rows.push({
      key: "recent",
      label: "Remove from recent",
      icon: "recent",
      onSelect: () => handlers.onClearRecent(project),
    });
  }

  // No "remove from list" here on purpose: it is one click, it looks like the destructive entry
  // beside it, and getting it wrong loses a project's place in the launcher for no reason. It
  // lives in the delete dialog, where the choice between forgetting and deleting is spelled out.
  rows.push({
    key: "delete",
    label: "Delete project…",
    icon: "delete",
    separatorBefore: true,
    destructive: true,
    onSelect: () => handlers.onDelete(project),
  });

  return rows;
}
