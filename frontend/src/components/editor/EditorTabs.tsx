import { FileCode, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OpenFile } from "@/store/app-store";

export interface EditorTabsProps {
  files: OpenFile[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  /** Invoked on tab double-click; receives the tab's path. */
  onSave?: (path: string) => void;
}

export function EditorTabs({ files, activePath, onSelect, onClose, onSave }: EditorTabsProps) {
  if (files.length === 0) return null;

  return (
    <div className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-border bg-chrome">
      {files.map((file) => {
        const isActive = file.path === activePath;
        return (
          <div
            key={file.path}
            className={cn(
              "group relative flex shrink-0 items-stretch border-r border-border",
              isActive ? "bg-background" : "bg-chrome hover:bg-chrome-raised",
            )}
          >
            {isActive ? <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" /> : null}
            <button
              type="button"
              title={file.path}
              onClick={() => {
                onSelect(file.path);
              }}
              onDoubleClick={() => {
                onSave?.(file.path);
              }}
              className={cn(
                "flex min-w-0 max-w-[220px] items-center gap-1.5 pl-2.5 text-2xs",
                isActive ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <FileCode className="size-3.5 shrink-0" />
              <span className="truncate">{file.path.split("/").pop() ?? file.path}</span>
            </button>
            <button
              type="button"
              title="close"
              onClick={() => {
                onClose(file.path);
              }}
              className="flex w-6 items-center justify-center text-muted-foreground hover:text-foreground"
            >
              {file.dirty ? (
                <>
                  <span className="size-1.5 rounded-full bg-primary group-hover:hidden" />
                  <X className="hidden size-3 group-hover:block" />
                </>
              ) : (
                <X className="size-3" />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
