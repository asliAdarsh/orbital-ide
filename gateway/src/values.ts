/**
 * Small readers for values that came off the wire.
 *
 * A request body, a Firestore document and an upstream error page are all `unknown` here. These
 * helpers keep the narrowing in one place so no route has to reach for a cast, and so a field the
 * client sent as the wrong JSON type is treated as absent instead of crashing the proxy.
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A JSON object from text, or null when the text is not one — an HTML error page, a stale frame. */
export function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/** The character length of a value as JSON — what an estimate needs, and nothing else. */
export function jsonLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    // Only reachable for a cyclic structure, which `JSON.parse` cannot produce. An estimate is
    // allowed to be wrong by omission; it is not allowed to throw on the response path.
    return 0;
  }
}

/** Every string inside a value, concatenated — the text a completion's deltas are made of. */
export function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce<number>((total, item) => total + textLength(item), 0);
  const record = asRecord(value);
  if (record === null) return 0;
  return Object.values(record).reduce<number>((total, item) => total + textLength(item), 0);
}
