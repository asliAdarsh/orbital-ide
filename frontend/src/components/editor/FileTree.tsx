import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileNode } from "@/types/protocol";

export interface FileTreeProps {
  root: FileNode;
  onOpenFile: (path: string) => void;
  activePath?: string | null;
  className?: string;
}

/** Depth 0–1 open by default: the workspace root plus its immediate directories. */
function autoExpand(root: FileNode): Set<string> {
  const next = new Set<string>();
  if (root.type === "directory") next.add(root.path);
  for (const child of root.children ?? []) {
    if (child.type === "directory" && child.ignored !== true) next.add(child.path);
  }
  return next;
}

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  activePath: string | null;
}

function TreeNode({ node, depth, expanded, onToggle, onOpenFile, activePath }: TreeNodeProps) {
  const isDirectory = node.type === "directory";
  const isOpen = isDirectory && expanded.has(node.path);
  const dimmed = node.ignored === true;

  return (
    <>
      <button
        type="button"
        disabled={isDirectory && dimmed}
        style={{ paddingLeft: depth * 12 + 6 }}
        onClick={() => {
          if (isDirectory) onToggle(node.path);
          else onOpenFile(node.path);
        }}
        className={cn(
          "flex h-6 w-full items-center gap-1 pr-2 text-left text-xs",
          activePath === node.path
            ? "bg-primary/10 text-foreground"
            : "text-muted-foreground hover:bg-chrome-raised hover:text-foreground",
          dimmed && "cursor-default opacity-50 hover:bg-transparent",
        )}
      >
        {isDirectory ? (
          isOpen ? (
            <ChevronDown className="size-3 shrink-0" />
          ) : (
            <ChevronRight className="size-3 shrink-0" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {isDirectory ? (
          isOpen ? (
            <FolderOpen className="size-3.5 shrink-0" />
          ) : (
            <Folder className="size-3.5 shrink-0" />
          )
        ) : (
          <FileText className="size-3.5 shrink-0" />
        )}
        <span className="truncate" title={node.path}>
          {node.name}
        </span>
      </button>
      {isOpen
        ? (node.children ?? []).map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              activePath={activePath}
            />
          ))
        : null}
    </>
  );
}

export function FileTree({ root, onOpenFile, activePath, className }: FileTreeProps) {
  const rootKey = root.path || root.name;
  const [expanded, setExpanded] = useState<Set<string>>(() => autoExpand(root));
  const [knownRootKey, setKnownRootKey] = useState(rootKey);

  // Re-seed only when a different workspace is mounted into the same component
  // instance; watcher-driven refetches must not collapse what the user opened.
  if (knownRootKey !== rootKey) {
    setKnownRootKey(rootKey);
    setExpanded(autoExpand(root));
  }

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className={cn("min-h-0 overflow-y-auto py-1", className)}>
      <TreeNode
        node={root}
        depth={0}
        expanded={expanded}
        onToggle={toggle}
        onOpenFile={onOpenFile}
        activePath={activePath ?? null}
      />
    </div>
  );
}
