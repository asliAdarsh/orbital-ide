/**
 * The Orbital mark: the bordered initial and the wordmark beside it.
 *
 * Two bars show it — the IDE's title bar and the launcher's, which are never on screen together —
 * and a brand mark that drifts between them is the kind of detail nobody notices until it looks
 * wrong.
 */

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`flex shrink-0 items-center gap-2 ${className ?? ""}`}>
      <span
        aria-hidden
        className="flex h-3.5 w-3.5 items-center justify-center border border-border font-mono text-2xs leading-none text-foreground"
      >
        O
      </span>
      <span className="font-mono text-2xs uppercase tracking-[0.2em] text-muted-foreground">Orbital</span>
    </span>
  );
}
