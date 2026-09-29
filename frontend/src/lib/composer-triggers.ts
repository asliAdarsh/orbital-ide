/**
 * What the composer's typing triggers mean, and how their lists are filtered.
 *
 * The composer has two triggers that both lean on "the word the caret is in": `/` opens the
 * command palette and `@` opens the mention picker. Both are decided from the text and the caret
 * position alone, so they are testable without a DOM and the composer only has to hand over two
 * numbers.
 */

/** A trigger under the caret: where it starts, where the caret is, and what was typed since. */
export interface ComposerTrigger {
  kind: "slash" | "mention";
  /** Index of the trigger character itself — the first one to replace when a row is taken. */
  start: number;
  /** Caret index; the end of the trigger text. */
  end: number;
  /** What follows the trigger character, up to the caret. */
  query: string;
}

/**
 * The trigger the caret sits in, or null.
 *
 * "Start of a word" is the whole rule, and it is what keeps the two false positives out: a word is
 * a run of non-whitespace, so `/` inside `src/foo` and `@` inside `user@host` are not at a word's
 * start and never fire. A `/` whose query already contains another `/` is a path, not a command —
 * `https://` and `/usr/bin` both land there — so a slash trigger stops being a command the moment
 * it grows past one segment.
 */
export function findComposerTrigger(text: string, caret: number): ComposerTrigger | null {
  const end = Math.max(0, Math.min(caret, text.length));
  let start = end;
  while (start > 0 && !/\s/.test(text.charAt(start - 1))) start -= 1;
  const word = text.slice(start, end);
  const head = word.charAt(0);
  if (head !== "/" && head !== "@") return null;
  const query = word.slice(1);
  if (head === "/" && query.includes("/")) return null;
  return { kind: head === "/" ? "slash" : "mention", start, end, query };
}

/**
 * A subsequence score for a filter box: higher is a better match, null means "does not match".
 *
 * Typed characters must appear in order, but adjacent and word-boundary hits count for more, which
 * is what makes `pfp` find `ProviderModelPicker` and `mdl` find `model`. The penalty for skipping
 * ahead is capped so one very long path cannot outscore a short exact prefix.
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (query === "") return 0;
  const needle = query.toLowerCase();
  const haystack = target.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const character of needle) {
    const at = haystack.indexOf(character, from);
    if (at === -1) return null;
    const adjacent = at === previous + 1;
    const atBoundary = at === 0 || "/-_. ".includes(haystack.charAt(at - 1));
    score += 1 + (adjacent ? 3 : 0) + (atBoundary ? 2 : 0) - Math.min(at - from, 5);
    from = at + 1;
    previous = at;
  }
  return score;
}
