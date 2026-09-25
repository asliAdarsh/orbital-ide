import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, File, Folder, Paperclip, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { FileNode } from "@/types/protocol";

/**
 * The backend refuses a message carrying more than this many attachments, so the popover stops the
 * user here rather than letting a run fail on a limit they cannot see. Mirrors the backend cap.
 */
const MAX_ATTACHMENTS = 12;
/** Indent per tree level, in pixels — deeper than this and a path name has no room left. */
const INDENT_PX = 10;

export interface ComposerAttachmentsProps {
  /** The workspace tree as the sidebar loaded it; null until a folder is open. */
  tree: FileNode | null;
  /** Workspace-relative paths already ticked, in the order they were picked. */
  selected: string[];
  onAttach(path: string): void;
  onDetach(path: string): void;
}

/** Last path segment: a chip has room for the name, and the tooltip carries the whole path. */
function fileName(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] || path;
}

/**
 * The attach button, its workspace-tree popover, and the removable chips for what was picked.
 *
 * The trigger and the chips are returned as siblings rather than wrapped in a container: the
 * composer's action row is what wraps, so a long list of picks flows onto more lines instead of
 * squeezing the buttons beside it. Popover and chips are therefore styled for that row.
 */
export function ComposerAttachments({
  tree,
  selected,
  onAttach,
  onDetach,
}: ComposerAttachmentsProps) {
  // Which folders are unfolded. Held here rather than in the popover content so reopening the
  // popover returns to the same place in the tree.
  const [expanded, setExpanded] = useState<string[]>([]);
  const atLimit = selected.length >= MAX_ATTACHMENTS;
  const entries = tree?.children ?? [];

  const toggleExpanded = (path: string) =>
    setExpanded((current) =>
      current.includes(path) ? current.filter((entry) => entry !== path) : [...current, path],
    );

  const renderNode = (node: FileNode, depth: number): ReactNode => {
    const isDirectory = node.type === "directory";
    const isOpen = expanded.includes(node.path);
    const checked = selected.includes(node.path);
    const hasChildren = isDirectory && (node.children?.length ?? 0) > 0;
    return (
      <div key={node.path}>
        <div className="flex items-center gap-1" style={{ paddingLeft: depth * INDENT_PX }}>
          {hasChildren ? (
            <button
              type="button"
              aria-expanded={isOpen}
              aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.name}`}
              onClick={() => toggleExpanded(node.path)}
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            >
              {isOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </button>
          ) : (
            // Keeps every row's checkbox on one column, so the tree reads as a tree.
            <span className="size-3 shrink-0" />
          )}
          <label
            title={node.path}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-chrome-raised"
          >
            <input
              type="checkbox"
              checked={checked}
              // Past the cap only unticking is left; the box that would exceed it goes dead.
              disabled={atLimit && !checked}
              onChange={() => (checked ? onDetach(node.path) : onAttach(node.path))}
              className="size-3 shrink-0 accent-primary disabled:opacity-40"
            />
            {isDirectory ? (
              <Folder className="size-3 shrink-0 text-phase-design" aria-hidden />
            ) : (
              <File className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0 truncate">{node.name}</span>
          </label>
        </div>
        {isOpen && node.children
          ? node.children.map((child) => renderNode(child, depth + 1))
          : null}
      </div>
    );
  };

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            size="icon"
            variant="outline"
            className={cn("size-6", selected.length > 0 && "text-primary")}
            aria-label="Attach workspace files"
            title="Attach workspace files or folders"
          >
            <Paperclip className="size-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          {tree === null ? (
            <p className="p-2 text-muted-foreground">
              Open a folder first — attachments are read from the workspace.
            </p>
          ) : entries.length === 0 ? (
            <p className="p-2 text-muted-foreground">This folder has nothing to attach.</p>
          ) : (
            <>
              <div className="max-h-56 overflow-y-auto p-1">{entries.map((node) => renderNode(node, 0))}</div>
              {/*
                The one place the run/chat difference is worth saying out loud: a chat turn can
                carry an image the model actually looks at, a phase run only names it.
              */}
              <p className="border-t border-border px-2 py-1 text-muted-foreground">
                {selected.length}/{MAX_ATTACHMENTS} picked. Chat turns send what you pick; a build
                run gets text only — images are named, not looked at.
              </p>
            </>
          )}
        </PopoverContent>
      </Popover>
      {selected.map((path) => (
        <span
          key={path}
          className="flex h-6 min-w-0 max-w-40 items-center gap-1 rounded border border-border bg-chrome-raised px-1.5 text-2xs text-foreground"
        >
          <span className="min-w-0 truncate" title={path}>
            {fileName(path)}
          </span>
          <button
            type="button"
            aria-label={`Remove ${path}`}
            title={`Remove ${path}`}
            onClick={() => onDetach(path)}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </>
  );
}
