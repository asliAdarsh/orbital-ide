/**
 * What a completed request cost, and where that figure goes.
 *
 * Counting is best-effort on purpose. It exists to enforce an allowance and to leave an auditable
 * record of what an account spent, not to bill anyone: a bookkeeping failure must never turn a
 * completion the caller already received into an error, and a figure the upstream did not report is
 * an estimate that says so in the README rather than a fiction dressed as a measurement.
 */

import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { adminApp } from "./admin";
import { CHARS_PER_TOKEN_ESTIMATE } from "./config";
import { asFiniteNumber, asRecord } from "./values";

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** True when the upstream reported nothing and this came from character counts. */
  readonly estimated: boolean;
}

/**
 * The upstream's own figure, when it reported one. `total_tokens` is preferred and the parts are
 * summed only when it is absent, because that is the number the upstream charged for.
 */
export function usageFromCompletion(payload: Record<string, unknown>): TokenUsage | null {
  const usage = asRecord(payload.usage);
  if (usage === null) return null;
  const promptTokens = asFiniteNumber(usage.prompt_tokens) ?? 0;
  const completionTokens = asFiniteNumber(usage.completion_tokens) ?? 0;
  const totalTokens = asFiniteNumber(usage.total_tokens) ?? promptTokens + completionTokens;
  if (totalTokens <= 0 && promptTokens <= 0 && completionTokens <= 0) return null;
  return { promptTokens, completionTokens, totalTokens, estimated: false };
}

/**
 * The documented estimate for an upstream that reports no usage: four characters per token, the
 * usual rule of thumb for English and code. It over-counts JSON overhead and under-counts dense
 * tokens, which is acceptable for an allowance and is exactly why the record it produces is not
 * presented anywhere as a bill.
 */
export function estimateUsage(promptChars: number, completionChars: number): TokenUsage {
  const promptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN_ESTIMATE);
  const completionTokens = Math.ceil(completionChars / CHARS_PER_TOKEN_ESTIMATE);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: true };
}

/**
 * Move one account's counters and write the record of this call, in one commit — a counter that
 * moved without a record, or a record without a counter, is a discrepancy nobody can reconstruct.
 * The credit charge is here too: one prompt costs one prompt's credits whatever the completion was.
 *
 * The period's start is not decided here. It was decided by the entitlement read that let this
 * request through — the same request, moments earlier — and that read is what wrote
 * `creditsUsed = 0` and moved `creditsResetAt` forward when the month had turned. This write only
 * adds to the period that read established. (A charge landing in the instant between a period's end
 * and the read that would notice it is the one case this does not order: it adds to the counter the
 * next read then zeroes. A read-then-write transaction would close that window, and the Admin SDK's
 * transaction read turns a dead client into an unhandled rejection — a worse trade for a window
 * under a second.)
 *
 * Never throws, and never waits on anything the caller needs: the completion has already been
 * delivered by the time this runs. A failure is logged with the account, the model and the token
 * count, and with no prompt, no completion and no credential: a bookkeeping failure deserves an
 * operator's attention, not a copy of somebody's code.
 */
export async function recordUsage(
  uid: string,
  model: string,
  usage: TokenUsage,
  credits: number,
): Promise<void> {
  try {
    const db = getFirestore(adminApp());
    const batch = db.batch();
    batch.set(
      db.doc(`users/${uid}`),
      {
        tokensUsed: FieldValue.increment(usage.totalTokens),
        creditsUsed: FieldValue.increment(credits),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    batch.set(db.collection(`users/${uid}/usage`).doc(), {
      at: FieldValue.serverTimestamp(),
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      credits,
    });
    await batch.commit();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[orbital-gateway] usage accounting failed", {
      uid,
      model,
      totalTokens: usage.totalTokens,
      estimated: usage.estimated,
      reason: reason.slice(0, 200),
    });
  }
}
