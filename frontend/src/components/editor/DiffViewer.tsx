import { DiffEditor } from "@monaco-editor/react";
import { defineOrbitalTheme } from "@/components/editor/CodeEditor";
import { languageFor } from "@/lib/languages";
import { cn } from "@/lib/utils";

export interface DiffViewerProps {
  /** Path of the modified side; drives syntax highlighting for both panes. */
  path: string;
  original: string;
  modified: string;
  className?: string;
}

export function DiffViewer({ path, original, modified, className }: DiffViewerProps) {
  return (
    <div className={cn("h-full w-full", className)}>
      <DiffEditor
        original={original}
        modified={modified}
        language={languageFor(path)}
        theme="orbital-dark"
        beforeMount={defineOrbitalTheme}
        options={{
          readOnly: true,
          renderSideBySide: true,
          minimap: { enabled: false },
          fontFamily: "JetBrains Mono",
          fontSize: 12.5,
          automaticLayout: true,
        }}
      />
    </div>
  );
}
