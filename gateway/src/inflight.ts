/**
 * How many requests one account may have open at once, per instance.
 *
 * This is an abuse floor and nothing more, and the comment says so because the alternative is a
 * reader who assumes it is a rate limit. The map lives in this instance's memory; Cloud Functions
 * runs as many instances as it needs to, each with its own map. So the cap bounds what one instance
 * will hold open for one account, which is what stops a runaway client from occupying every
 * connection this instance has. A durable, global limit is a later decision: it needs shared state
 * and a story for what happens when that state is unavailable.
 */

import { MAX_IN_FLIGHT_PER_ACCOUNT } from "./config";

const inFlight = new Map<string, number>();

/** Whether this account may start another request here; false means it is at the cap. */
export function beginRequest(uid: string): boolean {
  const open = inFlight.get(uid) ?? 0;
  if (open >= MAX_IN_FLIGHT_PER_ACCOUNT) return false;
  inFlight.set(uid, open + 1);
  return true;
}

/** Always called in a `finally`: a counter that leaks would lock an account out for the instance's life. */
export function endRequest(uid: string): void {
  const open = inFlight.get(uid) ?? 0;
  if (open <= 1) inFlight.delete(uid);
  else inFlight.set(uid, open - 1);
}
