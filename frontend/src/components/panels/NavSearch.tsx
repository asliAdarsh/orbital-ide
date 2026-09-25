/**
 * Centred workspace search for the nav bar.
 *
 * The field is debounced and every response is stamped with the request that asked for it, so a
 * slow early query cannot overwrite the results of a later one. Hits open into the editor, which
 * is why the panel closes as soon as one is taken.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Search } from "lucide-react";

import { api, errorMessage } from "@/lib/api";
import { useAppStore } from "@/store/app-store";
import { toast } from "@/components/common/Toaster";
import type { SearchResponse } from "@/types/protocol";

/** Below this the backend would scan the whole workspace for a single letter. */
const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 250;
const RESULT_LIMIT = 50;

export interface NavSearchHandle {
  focus(): void;
}

/**
 * The search field. `ref` is the nav's Search button handle — the button never owns the input,
 * it only asks this component to put the caret in it.
 */
export const NavSearch = forwardRef<NavSearchHandle>(function NavSearch(_props, ref) {
  const projectPath = useAppStore((s) => s.project?.projectPath ?? null);
  const openFile = useAppStore((s) => s.openFile);

  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** Monotonic; a response whose id is stale belongs to a query the user has moved past. */
  const requestIdRef = useRef(0);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  // Ctrl/Cmd+K reaches the field from anywhere — including from inside the editor, whose own
  // keybinding layer would otherwise consume the chord before it bubbles to the window.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Clicking anywhere outside the field dismisses the hit list.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!projectPath || trimmed.length < MIN_QUERY_LENGTH) {
      setResults(null);
      setSearching(false);
      setOpen(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    setSearching(true);
    setOpen(true);
    const timer = window.setTimeout(() => {
      void api.search(trimmed, RESULT_LIMIT).then(
        (response) => {
          if (requestId !== requestIdRef.current) return;
          setResults(response);
          setSearching(false);
          setOpen(true);
        },
        (cause: unknown) => {
          if (requestId !== requestIdRef.current) return;
          setResults(null);
          setSearching(false);
          setOpen(false);
          toast.error(errorMessage(cause, "Search failed."));
        },
      );
    }, DEBOUNCE_MS);

    // Clearing the timer also invalidates this request: nothing it resolves later may land.
    return () => {
      window.clearTimeout(timer);
      requestIdRef.current += 1;
    };
  }, [query, projectPath]);

  const handleSelect = async (path: string) => {
    try {
      openFile(await api.readFile(path));
      setQuery("");
      setResults(null);
      setOpen(false);
    } catch (cause) {
      toast.error(errorMessage(cause, "Search failed."));
    }
  };

  const disabled = projectPath === null;
  const hits = results?.hits ?? null;

  return (
    <div ref={rootRef} className="relative w-full max-w-[729px]">
      <Search
        aria-hidden
        className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/70"
      />
      <input
        ref={inputRef}
        type="text"
        value={query}
        disabled={disabled}
        spellCheck={false}
        placeholder={disabled ? "Open a folder to search" : "Search the workspace"}
        title={
          disabled ? "Open a folder to search the workspace" : "Search the workspace (Ctrl/Cmd + K)"
        }
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          setQuery("");
          setResults(null);
          setOpen(false);
        }}
        className="h-[26px] w-full border border-input bg-chrome-sunken pl-6 pr-2 text-2xs text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
      />

      {open && (
        <div className="absolute left-0 right-0 top-[28px] z-40 max-h-72 overflow-y-auto border border-border bg-popover">
          {searching && (
            <p className="px-2 py-1 font-mono text-2xs text-muted-foreground">searching…</p>
          )}

          {!searching && hits !== null && hits.length === 0 && (
            <p className="px-2 py-1 font-mono text-2xs text-muted-foreground">no matches</p>
          )}

          {!searching &&
            hits?.map((hit) => (
              <button
                key={`${hit.path}:${hit.line}`}
                type="button"
                onClick={() => void handleSelect(hit.path)}
                title={`${hit.path}:${hit.line}`}
                className="flex w-full items-baseline gap-2 px-2 py-1 text-left text-2xs transition-colors hover:bg-chrome-raised"
              >
                <span className="max-w-[45%] shrink-0 truncate font-mono text-muted-foreground">
                  {hit.path}:{hit.line}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-foreground">{hit.text}</span>
              </button>
            ))}

          {!searching && results?.truncated && (
            <p className="border-t border-border px-2 py-1 font-mono text-2xs text-muted-foreground/70">
              truncated — narrow the query to see the rest
            </p>
          )}
        </div>
      )}
    </div>
  );
});
