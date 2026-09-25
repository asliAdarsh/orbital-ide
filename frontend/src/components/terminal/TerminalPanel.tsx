import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { Square, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CANCEL_LINE, createLineAssembler } from "@/lib/terminal-input";
import { cn, formatDuration } from "@/lib/utils";
import { useAppStore, type TerminalEntry } from "@/store/app-store";
import "@xterm/xterm/css/xterm.css";

/**
 * One shell's viewport. The bottom panel mounts a fresh instance per terminal (via `key`), so
 * a panel only ever replays the transcript it is handed and never a stream shared with another
 * shell. Behaviour is otherwise per-instance: nothing here is keyed off a single global stream.
 */
export interface TerminalPanelProps {
  onExec: (command: string) => void;
  onCancel: () => void;
  entries: TerminalEntry[];
  activeId: string | null;
  className?: string;
}

/** ANSI 256-colour greys/ambers keep the buffer legible without inventing hex values. */
const DIM = "\x1b[38;5;245m";
const WARN = "\x1b[38;5;215m";
const RESET = "\x1b[0m";

const ORBITAL_THEME: ITheme = {
  background: "rgba(0, 0, 0, 0)",
  foreground: "#D7DEE8",
  cursor: "#C8F751",
  selectionBackground: "rgba(200, 247, 81, 0.2)",
  black: "#0A0B0D",
  brightGreen: "#C8F751",
};

interface EntryProgress {
  /** Characters of `entry.output` already on screen. */
  streamed: number;
  settled: boolean;
}

export function TerminalPanel({
  onExec,
  onCancel,
  entries,
  activeId,
  className,
}: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const progressRef = useRef(new Map<string, EntryProgress>());
  /** Commands the user typed, already echoed as keystrokes, so the replay skips them. */
  const typedRef = useRef<string[]>([]);
  const cwdRef = useRef("");
  const onExecRef = useRef(onExec);

  useEffect(() => {
    onExecRef.current = onExec;
  }, [onExec]);

  // Created once and fully torn down: StrictMode's double mount must not leave a
  // second buffer, addon set or observer alive.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      theme: ORBITAL_THEME,
      // xterm ignores a non-opaque theme background unless transparency is allowed.
      allowTransparency: true,
      convertEol: true,
      fontFamily: "JetBrains Mono",
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(host);
    termRef.current = term;

    const cwd = useAppStore.getState().project?.projectPath ?? "";
    cwdRef.current = cwd;
    progressRef.current.clear();
    typedRef.current = [];

    term.writeln(`${DIM}orbital shell · ${cwd || "no workspace"}${RESET}`);
    term.write(`\r\n${cwd} $ `);

    const resize = () => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fit.fit();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    let lineReported = false;
    const assembler = createLineAssembler(
      (line) => {
        lineReported = true;
        if (line === CANCEL_LINE) {
          term.write(`${DIM}input cancelled${RESET}\r\n`);
          term.write(`${cwd} $ `);
          return;
        }
        typedRef.current.push(line);
        onExecRef.current(line);
      },
      (text) => {
        term.write(text);
      },
    );

    const input = term.onData((data) => {
      lineReported = false;
      assembler.feed(data);
      // The assembler swallows a bare Enter, so the prompt has to be redrawn here.
      if (data.includes("\r") && !lineReported) term.write(`${cwd} $ `);
    });

    return () => {
      observer.disconnect();
      input.dispose();
      fit.dispose();
      links.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // Replays the transcript this shell owns: everything in `entries` on mount (the panel is
  // remounted per terminal), then only the delta on each later render.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const cwd = cwdRef.current;

    const lastEntry = entries[entries.length - 1];
    let settledLast = false;

    for (const entry of entries) {
      const progress = progressRef.current.get(entry.id) ?? { streamed: 0, settled: false };
      if (!progressRef.current.has(entry.id)) {
        progressRef.current.set(entry.id, progress);
        const typedIndex = typedRef.current.indexOf(entry.command);
        if (typedIndex >= 0) {
          typedRef.current.splice(typedIndex, 1);
        } else {
          term.write(`\r\n${DIM}$ ${RESET}\x1b[1m${entry.command}${RESET}\r\n`);
        }
      }

      if (entry.output.length > progress.streamed) {
        term.write(entry.output.slice(progress.streamed));
        progress.streamed = entry.output.length;
      }

      if (entry.result && !progress.settled) {
        progress.settled = true;
        const result = entry.result;
        // Live frames merge both channels into `entry.output`; the exit frame carries
        // the full streams, so only the part the buffer has not shown yet is written.
        const full = result.stdout + result.stderr;
        if (full.length > progress.streamed && full.startsWith(entry.output)) {
          const remainder = full.slice(entry.output.length);
          if (remainder) term.write(remainder);
        }
        progress.streamed = Math.max(progress.streamed, full.length);

        const detail =
          result.error ??
          (result.timedOut
            ? `timed out after ${formatDuration(result.durationMs)}`
            : `exit ${result.exitCode ?? "?"} · ${formatDuration(result.durationMs)}`);
        term.write(`${result.exitCode === 0 && !result.error ? DIM : WARN}${detail}${RESET}\r\n`);
        if (lastEntry && entry.id === lastEntry.id) settledLast = true;
      }
    }

    if (settledLast) term.write(`\r\n${cwd} $ `);
  }, [entries]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-chrome-sunken", className)}>
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-2">
        <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <Terminal className="size-3.5" />
          terminal
          {activeId ? <span className="text-primary">running</span> : null}
        </span>
        {activeId ? (
          <Button size="xs" variant="ghost" onClick={onCancel}>
            <Square className="size-3" />
            stop
          </Button>
        ) : null}
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 px-2 py-1" />
      {entries.length === 0 ? (
        <div className="shrink-0 border-t border-border px-2 py-1 text-2xs text-muted-foreground">
          hint: run npm test, git status, or any shell command
        </div>
      ) : null}
    </div>
  );
}
