/**
 * Reading a stream while relaying it.
 *
 * The stream the client receives is the upstream's bytes, untouched. This scanner runs alongside
 * that relay on a copy of the decoded text, for one reason: the upstream reports `usage` in the
 * last frame before `[DONE]` when it reports it at all, and when it does not, the deltas it did send
 * are the only evidence of what the completion cost. Nothing the scanner does changes a byte the
 * client sees.
 *
 * It also refuses to grow without bound. Accounting is best-effort; a 40 MB completion must not turn
 * into a 40 MB buffer on a gateway instance. Past the budget the scanner stops counting and says so,
 * and the caller decides what to do with the partial figure.
 */

import { MAX_ACCOUNTING_BYTES } from "./config";
import type { Failure } from "./errors";
import { usageFromCompletion, type TokenUsage } from "./usage";
import { asRecord, textLength } from "./values";

export interface StreamScan {
  /** The upstream's own figure, when one arrived. */
  readonly usage: TokenUsage | null;
  /** Characters of completion text seen, which is what an estimate is made from. */
  readonly completionChars: number;
  /** False when the byte budget ran out before the stream ended. */
  readonly complete: boolean;
}

export class StreamScanner {
  private buffered = "";
  private bytes = 0;
  private usage: TokenUsage | null = null;
  private completionChars = 0;
  private truncated = false;

  /** Feed one relayed chunk: its decoded text, and the byte length it arrived as. */
  push(text: string, bytes: number): void {
    if (this.truncated) return;
    if (this.bytes + bytes > MAX_ACCOUNTING_BYTES) {
      this.truncated = true;
      return;
    }
    this.bytes += bytes;
    this.buffered += text;

    // Events are newline-delimited and a chunk may end mid-line, so the tail stays buffered until
    // the rest of it arrives. `trim` on each line is what makes a CRLF upstream work too.
    let end = this.buffered.indexOf("\n");
    while (end >= 0) {
      this.consume(this.buffered.slice(0, end).trim());
      this.buffered = this.buffered.slice(end + 1);
      end = this.buffered.indexOf("\n");
    }
  }

  private consume(line: string): void {
    if (!line.startsWith("data:")) return;
    const payload = line.slice("data:".length).trim();
    if (payload.length === 0 || payload === "[DONE]") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      // A frame this scanner cannot read is not the client's problem: the bytes were already
      // relayed, and an unreadable frame is the upstream's business.
      return;
    }
    const chunk = asRecord(parsed);
    if (chunk === null) return;

    const reported = usageFromCompletion(chunk);
    if (reported !== null) this.usage = reported;

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      const delta = asRecord(asRecord(choice)?.delta);
      if (delta === null) continue;
      // Content and tool-call arguments are both output the account is charged for.
      this.completionChars += textLength(delta.content) + textLength(delta.tool_calls);
    }
  }

  finish(): StreamScan {
    return { usage: this.usage, completionChars: this.completionChars, complete: !this.truncated };
  }
}

/**
 * A refusal inside an already-started stream. The status was sent before the upstream failed, so an
 * error frame is the only thing a client can still act on; ending silently would be indistinguishable
 * from a broken network at the client's end.
 */
export function sseErrorFrame(failureValue: Failure): string {
  const event = {
    error: {
      message: failureValue.message,
      type: failureValue.type,
      code: failureValue.code,
    },
  };
  return `data: ${JSON.stringify(event)}\n\n`;
}
