import Editor, { type Monaco } from "@monaco-editor/react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Monaco themes are global to the loader, and both CodeEditor and DiffViewer mount
 * before/without each other, so the guard lives beside the definition rather than
 * inside a single component's mount path.
 */
let themeDefined = false;

/** Mirrors the token palette in `index.css` so Monaco matches the surrounding shell. */
export function defineOrbitalTheme(monaco: Monaco): void {
  if (themeDefined) return;
  themeDefined = true;
  monaco.editor.defineTheme("orbital-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6B7480" },
      { token: "keyword", foreground: "5FD3E8" },
      { token: "string", foreground: "C8F751" },
      { token: "number", foreground: "F5B552" },
      { token: "type", foreground: "B99CF5" },
      { token: "type.identifier", foreground: "B99CF5" },
      { token: "function", foreground: "7FE0A8" },
      { token: "identifier", foreground: "E6EBF2" },
    ],
    colors: {
      "editor.background": "#0A0B0D",
      "editor.foreground": "#E6EBF2",
      "editor.lineHighlightBackground": "#12141A",
      "editor.selectionBackground": "#C8F75133",
      "editorCursor.foreground": "#C8F751",
      "editorGutter.background": "#0A0B0D",
    },
  });
}

export interface CodeEditorProps {
  value: string;
  language: string;
  /** Used as the Monaco model URI so every file keeps its own undo stack. */
  path: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
  className?: string;
}

export function CodeEditor({
  value,
  language,
  path,
  readOnly,
  onChange,
  onSave,
  className,
}: CodeEditorProps) {
  // Kept in a ref so the Ctrl+S command registered at mount never goes stale.
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  return (
    <Editor
      className={cn("h-full w-full", className)}
      path={path}
      language={language}
      value={value}
      theme="orbital-dark"
      beforeMount={defineOrbitalTheme}
      onMount={(editor, monaco) => {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          onSaveRef.current?.();
        });
      }}
      onChange={(next) => {
        onChange?.(next ?? "");
      }}
      loading={
        <div className="flex h-full items-center justify-center text-2xs text-muted-foreground">
          loading editor
        </div>
      }
      options={{
        readOnly,
        automaticLayout: true,
        minimap: { enabled: false },
        fontFamily: "JetBrains Mono",
        fontSize: 13,
        tabSize: 2,
        renderWhitespace: "selection",
        scrollBeyondLastLine: false,
        padding: { top: 12 },
      }}
    />
  );
}
