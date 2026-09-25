/**
 * Phase 2's canvas: the mocks, rendered, with the tools to say what is wrong with them.
 *
 * The page is shown here rather than only listed, because "does this look right" is the whole
 * question this phase asks. The tools exist because answering it in prose is clumsy: pointing at
 * the element and saying what should change produces a better instruction than describing it, and
 * the collected notes go to the architect as one turn.
 *
 * The mock is model-written markup, so it renders sandboxed and the tools work inside that
 * sandbox — see `lib/mock-picker.ts` for why, and what that costs.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  FileCode2,
  Loader2,
  MessageSquarePlus,
  MousePointerClick,
  Play,
  RefreshCw,
  Send,
  Square,
  X,
} from "lucide-react";

import { useAgentSocket } from "@/hooks/useAgentSocket";
import { ApiError, api } from "@/lib/api";
import { useAppStore } from "@/store/app-store";
import { describeElement, type PickedElement, type PickerMode } from "@/lib/mock-picker";
import { DESIGN_DIR, PHASE_SPECS, type FileNode, type PhaseInfo } from "@/types/protocol";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/common/EmptyState";
import { StatusDot } from "@/components/common/StatusDot";
import { toast } from "@/components/common/Toaster";
import { DesignPreview } from "@/components/panels/DesignPreview";
import { PHASE_RAIL } from "@/components/phases/PhaseStepper";
import { PHASE_PROMPTS } from "@/lib/phase-prompts";

const SPEC = PHASE_SPECS[1];
const DEFAULT_PROMPT = PHASE_PROMPTS.design;
const MOCK_PREFIX = `${DESIGN_DIR}/`;
const MOCK_SUFFIX = ".html";

/** A note the user left on one element, waiting to be sent to the architect. */
interface MockComment {
  id: string;
  path: string;
  selector: string;
  label: string;
  text: string;
}

interface PhaseRuntimeProps {
  onRun: (prompt: string) => void;
  onCancel(): void;
  running: boolean;
  /** The phase a confirmation moves on to, when there is one. */
  nextPhase: PhaseInfo | null;
  /** Starts that phase. Null when this is the last one. */
  onAdvance: (() => void) | null;
}

export function DesignPhase({ onRun, onCancel, running, nextPhase, onAdvance }: PhaseRuntimeProps) {
  const tree = useAppStore((s) => s.tree);
  const projectPath = useAppStore((s) => s.project?.projectPath ?? null);
  const status = useAppStore((s) => s.phaseStatus.design);
  const socket = useAgentSocket();

  const [selected, setSelected] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<PickerMode | null>(null);
  const [target, setTarget] = useState<PickedElement | null>(null);
  const [draft, setDraft] = useState("");
  const [comments, setComments] = useState<MockComment[]>([]);

  // Every mock the phase has written, sorted by path. Only files under `agent/design/` qualify, and
  // `ignored` nodes are dropped whole: those are the directories the backend walker skipped
  // (node_modules, .git, dist…), so a build output full of HTML can never be listed as a mock.
  const mocks = useMemo(() => {
    if (!tree) return [];
    const found: string[] = [];
    const pending: FileNode[] = [tree];
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node) continue;
      for (const child of node.children ?? []) {
        if (child.ignored) continue;
        if (child.type === "directory") pending.push(child);
        else if (child.path.startsWith(MOCK_PREFIX) && child.path.endsWith(MOCK_SUFFIX)) found.push(child.path);
      }
    }
    return found.sort();
  }, [tree]);

  // Follow the list: nothing selected, or the selection is gone, means the first screen.
  useEffect(() => {
    if (mocks.length === 0) {
      setSelected(null);
      return;
    }
    setSelected((current) => (current && mocks.includes(current) ? current : mocks[0]));
  }, [mocks]);

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      setHtml((await api.readFile(path)).content);
    } catch (cause) {
      setHtml(null);
      setError(cause instanceof ApiError ? (cause.detail ?? cause.message) : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selected) void load(selected);
  }, [selected, load]);

  const handlePick = (element: PickedElement) => {
    const mode = tool;
    setTool(null);
    if (mode === "grab") {
      void navigator.clipboard
        .writeText(describeElement(element))
        .then(() => toast.success("Element info copied to the clipboard."))
        .catch(() => toast.error("Could not reach the clipboard."));
      return;
    }
    setTarget(element);
    setDraft("");
  };

  const addComment = () => {
    if (!target || !selected || draft.trim().length === 0) return;
    setComments((current) => [
      ...current,
      {
        id: `${selected}:${target.selector}:${current.length}`,
        path: selected,
        selector: target.selector,
        label: `${target.tag}${target.id ? `#${target.id}` : ""}`,
        text: draft.trim(),
      },
    ]);
    setTarget(null);
    setDraft("");
  };

  const sendComments = () => {
    if (comments.length === 0 || !projectPath) return;
    const byPath = new Map<string, MockComment[]>();
    for (const comment of comments) {
      byPath.set(comment.path, [...(byPath.get(comment.path) ?? []), comment]);
    }
    const body = [...byPath.entries()]
      .map(([path, items]) =>
        [
          `${path}:`,
          ...items.map((item) => `- \`${item.selector}\` (${item.label}) — ${item.text}`),
        ].join("\n"),
      )
      .join("\n\n");
    socket.chat(
      "design",
      `Update these elements in the design mocks, keeping everything else as it is:\n\n${body}`,
      projectPath,
    );
    setComments([]);
    toast.success("Sent to the architect.");
  };

  const armed = (mode: PickerMode) => tool === mode;
  const toggleTool = (mode: PickerMode) => {
    setTarget(null);
    setTool((current) => (current === mode ? null : mode));
  };

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="relative flex shrink-0 items-center gap-2 border-b border-border bg-chrome-raised py-2 pl-3 pr-2">
        <span className={cn("absolute inset-y-0 left-0 w-0.5", PHASE_RAIL.design)} aria-hidden />
        <span className="flex h-5 w-5 shrink-0 items-center justify-center border border-border bg-chrome-sunken font-mono text-2xs text-muted-foreground">
          {SPEC.index}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{SPEC.title}</span>
        <span className="shrink-0 border border-border bg-chrome px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">{SPEC.agent}</span>
        <span className="shrink-0 font-mono text-2xs text-muted-foreground">{SPEC.deliverable}</span>
        <StatusDot state={status} />
      </header>

      {mocks.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <EmptyState
            icon={FileCode2}
            title="No design mocks yet"
            hint={`This phase builds one real HTML page per screen into ${DESIGN_DIR}/, each one a file you can open and preview right here.`}
            action={
              <Button size="sm" onClick={() => onRun(DEFAULT_PROMPT)} disabled={running}>
                <Play className="h-3.5 w-3.5" />
                Generate design mocks
              </Button>
            }
          />
        </div>
      ) : (
        <>
          {/* The phase's own bar: screens on the left, the tools for reading a page on the right. */}
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-chrome px-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {mocks.map((path) => {
                const name = path.slice(path.lastIndexOf("/") + 1, -MOCK_SUFFIX.length);
                return (
                  <button
                    key={path}
                    type="button"
                    onClick={() => {
                      setSelected(path);
                      setTool(null);
                      setTarget(null);
                    }}
                    title={path}
                    aria-pressed={path === selected}
                    className={cn(
                      "h-6 shrink-0 rounded px-2 text-2xs transition-colors",
                      path === selected
                        ? "bg-primary/10 text-foreground"
                        : "text-muted-foreground hover:bg-chrome-raised hover:text-foreground",
                    )}
                  >
                    {name}
                  </button>
                );
              })}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="xs"
                variant={armed("comment") ? "default" : "ghost"}
                title="Click an element in the page to leave a note for the architect"
                aria-pressed={armed("comment")}
                onClick={() => toggleTool("comment")}
              >
                <MessageSquarePlus className="h-3 w-3" />
                Comment
              </Button>
              <Button
                size="xs"
                variant={armed("grab") ? "default" : "ghost"}
                title="Click an element to copy its selector, classes, size and text"
                aria-pressed={armed("grab")}
                onClick={() => toggleTool("grab")}
              >
                <MousePointerClick className="h-3 w-3" />
                Grab element
              </Button>
              {comments.length > 0 ? (
                <Button
                  size="xs"
                  title="Send every note to the architect in one turn"
                  onClick={sendComments}
                  disabled={running || projectPath === null}
                >
                  <Send className="h-3 w-3" />
                  Send {comments.length}
                </Button>
              ) : null}
            </div>
          </div>

          {tool ? (
            <p className="shrink-0 border-b border-border bg-primary/5 px-3 py-1 text-2xs text-muted-foreground">
              {tool === "comment"
                ? "Click the element you want changed. Escape cancels."
                : "Click the element to copy its details. Escape cancels."}
            </p>
          ) : null}

          {comments.length > 0 ? (
            <ul className="flex shrink-0 flex-col border-b border-border bg-chrome">
              {comments.map((comment) => (
                <li key={comment.id} className="flex items-center gap-2 border-b border-border px-3 py-1 last:border-b-0">
                  <span className="shrink-0 font-mono text-2xs text-primary">{comment.selector}</span>
                  <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground" title={comment.text}>
                    {comment.text}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove note on ${comment.selector}`}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => setComments((current) => current.filter((item) => item.id !== comment.id))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="relative flex min-h-0 flex-1 flex-col">
            {error ? (
              <p className="shrink-0 border-b border-border bg-chrome px-3 py-1.5 text-2xs text-destructive">{error}</p>
            ) : null}

            {loading && html === null ? (
              <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-2xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                Reading {selected}…
              </div>
            ) : selected && html !== null ? (
              <DesignPreview
                path={selected}
                html={html}
                className="min-h-0 flex-1"
                mode={tool}
                onPick={handlePick}
                onCancelPick={() => setTool(null)}
                onReload={() => void load(selected)}
                reloading={loading}
              />
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center text-2xs text-muted-foreground">
                Pick a screen above.
              </div>
            )}

            {target ? (
              <div className="absolute inset-x-2 bottom-2 z-10 rounded border border-border bg-popover p-2 shadow-lg">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-2xs text-primary">{target.selector}</span>
                  <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                    {target.rect.width}×{target.rect.height}
                  </span>
                </div>
                <Textarea
                  autoFocus
                  rows={2}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      addComment();
                    }
                    if (event.key === "Escape") setTarget(null);
                  }}
                  placeholder="What should change here?"
                  className="mt-1.5 font-mono text-2xs"
                />
                <div className="mt-1.5 flex items-center justify-end gap-2">
                  <Button size="xs" variant="ghost" onClick={() => setTarget(null)}>
                    Cancel
                  </Button>
                  <Button size="xs" disabled={draft.trim().length === 0} onClick={addComment}>
                    Add note
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </>
      )}

      <footer className="flex shrink-0 items-center gap-2 border-t border-border bg-chrome-raised px-3 py-2">
        {running ? (
          <>
            <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <StatusDot state="running" pulse />
              {SPEC.agent} is working
            </span>
            <Button size="xs" variant="destructive" className="ml-auto" onClick={onCancel}>
              <Square className="h-3 w-3" />
              Cancel
            </Button>
          </>
        ) : (
          <>
            <span className="text-2xs text-muted-foreground">
              {mocks.length === 0
                ? "Awaiting run"
                : `${mocks.length} mock${mocks.length === 1 ? "" : "s"} in ${DESIGN_DIR}/`}
            </span>
            {mocks.length > 0 ? (
              <div className="ml-auto flex items-center gap-1.5">
                <Button size="xs" variant="secondary" onClick={() => onRun(DEFAULT_PROMPT)}>
                  <RefreshCw className="h-3 w-3" />
                  Regenerate
                </Button>
                {nextPhase && onAdvance ? (
                  <Button size="xs" onClick={onAdvance}>
                    <Check className="h-3 w-3" />
                    Design looks right → {nextPhase.title}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </footer>
    </section>
  );
}
