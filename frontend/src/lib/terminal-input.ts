/**
 * Line assembly for the integrated terminal.
 *
 * xterm.js has no local echo (there is no PTY behind it — command execution is a
 * request/response over the socket), so the panel feeds raw keystrokes here and writes
 * the returned display sequence to the terminal. One parser, one source of truth for
 * what the user typed.
 */

/** Sentinel handed to `onLine` when the user presses Ctrl-C. */
export const CANCEL_LINE = "__CANCEL__";

export interface LineAssembler {
  /** Consume raw xterm data, echoing it back and invoking `onLine` on Enter. */
  feed(data: string): void;
  /** Current partial line, for callers that need to redraw it. */
  readonly buffer: string;
}

const ENTER = "\r";
const NEWLINE = "\n";
const BACKSPACE = "\u007f";
const BACKSPACE_ALT = "\b";
const CANCEL = "\u0003";

/**
 * Build an assembler that echoes printable input and reports complete lines.
 *
 * @param onLine Called with the trimmed line on Enter, or {@link CANCEL_LINE} on Ctrl-C.
 * @param echo   Receives the exact text to write to the terminal for the keystrokes.
 */
export function createLineAssembler(
  onLine: (line: string) => void,
  echo?: (text: string) => void,
): LineAssembler {
  let buffer = "";
  const write = echo ?? (() => undefined);

  return {
    get buffer() {
      return buffer;
    },
    feed(data: string) {
      for (const char of data) {
        if (char === ENTER) {
          write("\r\n");
          const line = buffer.trim();
          buffer = "";
          if (line) onLine(line);
          continue;
        }
        if (char === NEWLINE) continue;
        if (char === CANCEL) {
          write("^C\r\n");
          buffer = "";
          onLine(CANCEL_LINE);
          continue;
        }
        if (char === BACKSPACE || char === BACKSPACE_ALT) {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            write("\b \b");
          }
          continue;
        }
        // Ignore control characters and escape sequences (arrows, function keys).
        if (char < " ") continue;
        buffer += char;
        write(char);
      }
    },
  };
}
