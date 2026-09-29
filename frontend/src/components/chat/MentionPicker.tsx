/**
 * The composer's `@` picker: files and folders from the open workspace.
 *
 * Two sources, deliberately. `GET /api/project/tree` is what the picker knows about structure — a
 * folder has to be offered as a folder, and the flat list of paths has to come from somewhere that
 * already respects the workspace's ignore rules. `GET /api/files/search` is what finds content: a
 * query that names nothing in a path can still appear inside a file, and a picker that only matched
 * names would hide exactly the hit the user was after.
 *
 * The component never takes focus. The caret stays in the composer — that is where the `@` was
 * typed — so the picker renders the list and answers arrow/enter/escape through
 * {@link MentionPickerHandle}, exactly as the commands palette does.
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Check, File, Folder } from "lucide-react";

import { api, errorMessage } from "@/lib/api";
import { fuzzyScore } from "@/lib/composer-triggers";
import { cn } from "@/lib/utils";
import { MAX_ATTACHMENTS } from "@/components/chat/ComposerAttachments";
import { useAppStore } from "@/store/app-store";
import type { FileNode } from "@/types/protocol";

/** Rows offered at once; past this the list is longer than the composer it hangs over. */
const MAX_ROWS = 12;
const SEARCH_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 250;

/** One offerable path, from the tree or from a content hit. */
interface Candidate {
  path: string;
  kind: "file" | "directory";
  /** The matched line, when this row came from a contents search. */
  snippet: string | null;
}

export interface MentionPickerHandle {
  /** True when the keystroke belonged to the picker, so the composer must not act on it. */
  handleKeyDown(event: React.KeyboardEvent<HTMLElement>): boolean;
}

export interface MentionPickerProps {
  /** What was typed after the `@`. */
  query: string;
  /** Paths already attached, so a row reads as picked and Enter unpicks it. */
  selected: string[];
  /** Cap reached: a row that would add another pick goes dead. */
  onToggle(path: string): void;
  /** Escape, or a click outside the composer. */
  onClose(): void;
}

/** Every path the tree holds, in tree order. Folders stay in the list: a folder is pickable too. */
function flatten(root: FileNode | null): Candidate[] {
  const out: Candidate[] = [];
  const walk = (node: FileNode) => {
    for (const child of node.children ?? []) {
      out.push({
        path: child.path,
        kind: child.type === "directory" ? "directory" : "file",
        snippet: null,
      });
      if (child.type === "directory") walk(child);
    }
  };
  if (root) walk(root);
  return out;
}

export const MentionPicker = forwardRef<MentionPickerHandle, MentionPickerProps>(function MentionPicker(
  { query, selected, onToggle, onClose },
  ref,
) {
  const tree = useAppStore((store) => store.tree);
  const flat = useMemo(() => flatten(tree), [tree]);
  const [hits, setHits] = useState<Candidate[]>([]);
  const [highlight, setHighlight] = useState(0);
  /** Monotonic; a response whose id is stale belongs to a query the user has moved past. */
  const requestIdRef = useRef(0);

  // Leaving the picker open on an empty query is what makes it multi-select: one pick removes the
  // `@word` and the list falls back to the top of the workspace, ready for the next one.
  const candidates = useMemo(() => {
    const needle = query.trim();
    const scored =
      needle === ""
        ? flat.slice(0, MAX_ROWS)
        : flat
            .map((candidate) => ({ candidate, score: fuzzyScore(needle, candidate.path) }))
            .filter((entry): entry is { candidate: Candidate; score: number } => entry.score !== null)
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_ROWS)
            .map((entry) => entry.candidate);
    const known = new Set(scored.map((candidate) => candidate.path));
    const extra = needle === "" ? [] : hits.filter((hit) => !known.has(hit.path));
    return [...scored, ...extra].slice(0, MAX_ROWS);
  }, [flat, hits, query]);

  useEffect(() => {
    setHighlight(0);
  }, [candidates.length, query]);

  useEffect(() => {
    const needle = query.trim();
    if (needle === "") {
      setHits([]);
      return;
    }
    const requestId = ++requestIdRef.current;
    const timer = window.setTimeout(() => {
      void api.search(needle, SEARCH_LIMIT).then(
        (response) => {
          if (requestId !== requestIdRef.current) return;
          const seen = new Set<string>();
          const found: Candidate[] = [];
          for (const hit of response.hits) {
            if (seen.has(hit.path)) continue;
            seen.add(hit.path);
            found.push({ path: hit.path, kind: "file", snippet: `${hit.line}: ${hit.text}`.trim() });
          }
          setHits(found);
        },
        (cause: unknown) => {
          if (requestId !== requestIdRef.current) return;
          // A contents search that fails is not worth a toast on every keystroke; the tree rows are
          // still there, and the log says what happened.
          useAppStore.getState().pushLog("warn", `File search failed: ${errorMessage(cause)}`);
          setHits([]);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    // Clearing the timer also invalidates this request: nothing it resolves later may land.
    return () => {
      window.clearTimeout(timer);
      requestIdRef.current += 1;
    };
  }, [query]);

  const atLimit = selected.length >= MAX_ATTACHMENTS;

  useImperativeHandle(
    ref,
    () => ({
      handleKeyDown: (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return true;
        }
        if (candidates.length === 0) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          setHighlight((current) => (current + step + candidates.length) % candidates.length);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const picked = candidates[highlight];
          if (picked) onToggle(picked.path);
          return true;
        }
        return false;
      },
    }),
    // Re-created whenever the list, the highlight or the callbacks move: the composer holds the
    // ref, and a handler frozen at mount would act on a list that is no longer on screen.
    [candidates, highlight, onToggle, onClose],
  );

  return (
    <div
      role="listbox"
      aria-label="Mention a file or folder"
      className="absolute bottom-full left-0 right-0 z-40 mb-1 max-h-64 overflow-y-auto border border-border bg-popover"
    >
      {candidates.length === 0 ? (
        <p className="px-2 py-1 font-mono text-2xs text-muted-foreground">
          {query.trim() === "" ? "this workspace has no files to mention" : "no matches"}
        </p>
      ) : (
        candidates.map((candidate, index) => {
          const picked = selected.includes(candidate.path);
          const disabled = atLimit && !picked;
          return (
            <button
              key={candidate.path}
              type="button"
              role="option"
              aria-selected={picked}
              disabled={disabled}
              title={disabled ? "Detach something first — the composer is at its attachment limit" : candidate.path}
              // Focus stays in the textarea: this is a list the caret is driving, and a click that
              // moved focus would break the next keystroke's target.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onToggle(candidate.path)}
              onMouseEnter={() => setHighlight(index)}
              className={cn(
                "flex w-full items-center gap-1.5 px-2 py-1 text-left text-2xs transition-colors disabled:opacity-40",
                index === highlight && !disabled ? "bg-chrome-raised" : "hover:bg-chrome-raised",
              )}
            >
              {candidate.kind === "directory" ? (
                <Folder className="size-3 shrink-0 text-phase-design" aria-hidden />
              ) : (
                <File className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-foreground">{candidate.path}</span>
              {candidate.snippet ? (
                <span className="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-muted-foreground">
                  {candidate.snippet}
                </span>
              ) : null}
              {picked ? <Check className="size-3 shrink-0 text-primary" aria-hidden /> : null}
            </button>
          );
        })
      )}
      <p className="border-t border-border px-2 py-1 text-muted-foreground">
        Enter or click adds the path as an attachment; Escape closes. Files and folders both count
        toward the {MAX_ATTACHMENTS} attachment limit.
      </p>
    </div>
  );
});
