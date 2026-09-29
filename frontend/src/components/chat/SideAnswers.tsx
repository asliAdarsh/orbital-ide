/**
 * `/ask` answers, held apart from the transcript.
 *
 * A side question is about the turn in flight: the runtime answers it without adding anything to the
 * session's history, so this must not look like a message pair. It is drawn as a card hanging above
 * the composer with its own accent edge and its own dismissal, which is what makes "this is not part
 * of the conversation" visible rather than a promise in a comment.
 *
 * The card owns its whole stream: a failed or cancelled question arrives as `agent.answer.end` with
 * an `error`, never as `agent.error`, so a failure here can never be mistaken for the run failing.
 */

import { CircleStop, MessagesSquare, X } from "lucide-react";

import { Markdown } from "@/components/common/Markdown";
import type { SideAnswer } from "@/store/app-store";

export interface SideAnswersProps {
  answers: SideAnswer[];
  onDismiss(requestId: string): void;
  /** Stop one answer while it is still streaming. The run is untouched. */
  onCancel(requestId: string): void;
}

export function SideAnswers({ answers, onDismiss, onCancel }: SideAnswersProps) {
  if (answers.length === 0) return null;
  return (
    <div className="max-h-72 shrink-0 space-y-1 overflow-y-auto border-t border-border p-2">
      {[...answers].reverse().map((answer) => (
        <div key={answer.requestId} className="border-l-2 border-l-accent bg-accent/5 pl-2 pr-1 py-1">
          <div className="flex items-center gap-1.5">
            <MessagesSquare className="size-3 shrink-0 text-accent" aria-hidden />
            <span className="shrink-0 text-2xs font-medium uppercase tracking-wider text-accent">
              Side answer
            </span>
            <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground" title={answer.question}>
              {answer.question}
            </span>
            {answer.streaming ? (
              <button
                type="button"
                aria-label="Stop this side answer"
                title="Stop this answer — the run carries on"
                onClick={() => onCancel(answer.requestId)}
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              >
                <CircleStop className="size-3" />
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Dismiss this side answer"
              title="Dismiss"
              onClick={() => onDismiss(answer.requestId)}
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
          <div className="mt-0.5 min-w-0">
            {answer.error !== null ? (
              <p className="text-2xs leading-relaxed text-destructive">
                The question did not finish: {answer.error}
              </p>
            ) : answer.content === "" ? (
              <p className="font-mono text-2xs text-muted-foreground">thinking…</p>
            ) : (
              <Markdown>{answer.content}</Markdown>
            )}
            {answer.streaming && answer.content !== "" ? (
              <span className="ml-0.5 inline-block h-3 w-1.5 animate-caret-blink bg-accent align-middle" />
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
