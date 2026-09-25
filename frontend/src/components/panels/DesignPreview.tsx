import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, RotateCw, X } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  COMMAND_MESSAGE_SOURCE,
  instrumentMock,
  parsePickMessage,
  type PickedElement,
  type PickerMode,
} from "@/lib/mock-picker";
import { Button } from "@/components/ui/button";

const VIEWER_MODES = ["preview", "source"] as const;
type ViewerMode = (typeof VIEWER_MODES)[number];

const VIEWER_LABEL: Record<ViewerMode, string> = {
  preview: "Preview",
  source: "Source",
};

export interface DesignPreviewProps {
  path: string;
  html: string;
  className?: string;
  /** Extra controls, shown in the header before the reload button. */
  tools?: ReactNode;
  /** The armed picking tool, or null for an ordinary preview. */
  mode?: PickerMode | null;
  onPick?(element: PickedElement): void;
  /** The frame reported that picking was abandoned (Escape inside the mock). */
  onCancelPick?(): void;
  /** Called when the viewer should be dismissed; the centre falls back to the phase canvas. */
  onClose?: () => void;
  /** Re-read the file from disk. */
  onReload?(): void;
  reloading?: boolean;
}

/**
 * The design mock: the page rendered for real, or its markup, with a reload that re-reads the file.
 *
 * SECURITY — the frame is sandboxed with `allow-scripts` and nothing else, and `allow-same-origin`
 * MUST NEVER be added. The markup is model-written content from the user's project, so a frame
 * holding our origin could reach `window.parent`, this app's DOM, its cookies and its storage — the
 * mock would be an XSS hole instead of a preview. Without `allow-same-origin` the frame gets an
 * opaque origin: scripts still run, which the mocks need, but nothing it does can touch us, and it
 * cannot talk its way back to same-origin privileges. `referrerPolicy="no-referrer"` keeps the
 * workspace path out of the mock's outbound requests, and `srcDoc` leaves it with no origin-bearing
 * URL of its own to navigate from.
 *
 * The picker runs inside that frame for the same reason — see `lib/mock-picker.ts`. The document is
 * instrumented once and stays put: re-injecting on every tool change would reload the mock and throw
 * away whatever state the user had built up in it.
 *
 * Source mode is a plain `<pre>` on purpose: this component owns no editor, so it can never fight
 * the centre's Monaco instance for buffers or focus.
 */
export function DesignPreview({
  path,
  html,
  className,
  tools,
  mode = null,
  onPick,
  onCancelPick,
  onClose,
  onReload,
  reloading = false,
}: DesignPreviewProps) {
  const [view, setView] = useState<ViewerMode>("preview");
  const frameRef = useRef<HTMLIFrameElement>(null);

  // Arm or disarm the tool inside the frame. The frame only acts on a mode it is told about, so an
  // uninstrumented mock is impossible: the script is always there, and inert.
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({ source: COMMAND_MESSAGE_SOURCE, mode }, "*");
  }, [mode, html]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const parsed = parsePickMessage(event.data, event.source === frameRef.current?.contentWindow);
      if (!parsed) return;
      if (parsed.kind === "cancelled") {
        onCancelPick?.();
        return;
      }
      if (parsed.kind === "pick") onPick?.(parsed.payload.element);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onPick, onCancelPick]);

  return (
    <section className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-chrome-raised pl-3 pr-1">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground" title={path}>
          {path}
        </span>

        {tools}

        <div className="flex shrink-0 items-center border border-border">
          {VIEWER_MODES.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              onClick={() => setView(id)}
              className={cn(
                "h-5 px-1.5 text-2xs transition-colors",
                view === id ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {VIEWER_LABEL[id]}
            </button>
          ))}
        </div>

        {onReload ? (
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            title="Reload from disk"
            aria-label="Reload from disk"
            disabled={reloading}
            onClick={onReload}
          >
            {reloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
          </Button>
        ) : null}

        {onClose ? (
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            title="Close preview"
            aria-label="Close preview"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </header>

      {view === "preview" ? (
        <iframe
          ref={frameRef}
          className="min-h-0 w-full flex-1 border-0 bg-background"
          srcDoc={instrumentMock(html)}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title={path}
          onLoad={() => frameRef.current?.contentWindow?.postMessage({ source: COMMAND_MESSAGE_SOURCE, mode }, "*")}
        />
      ) : (
        <pre className="h-full overflow-auto bg-chrome-sunken p-3 font-mono text-2xs">{html}</pre>
      )}
    </section>
  );
}
