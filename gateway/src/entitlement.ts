/**
 * Who is allowed to spend the Orbital key, and how much of their allowance is left.
 *
 * The account's document is the entitlement: a missing document means the default plan, which is
 * allowed, and anything the document does not say is allowed too. Only three things stop a run —
 * the account being suspended, the token allowance being used up, and the credits running out — and
 * the last is checked against the model's own cost, because a prompt is charged a fixed number of
 * credits rather than a number that depends on the completion.
 *
 * **The monthly reset is lazy.** A free-plan allowance comes back on the 1st of the month UTC, and
 * the first authenticated read on or after that instant is what zeroes `creditsUsed` and moves
 * `creditsResetAt` on. There is no scheduled function: the clock is checked wherever the document is
 * read or charged, so a period that ended while nobody was calling is corrected the moment somebody
 * does, and a second read in the same period changes nothing.
 *
 * The client may read this document; it may not write the fields that decide any of this. That is
 * enforced by `firestore.rules`, not here: this code runs with the Admin SDK, which bypasses rules
 * by design.
 */

import { getFirestore } from "firebase-admin/firestore";
import { adminApp } from "./admin";
import { DEFAULT_PLAN, entryAvailableOnPlan, planDefinition, type CatalogueEntry } from "./config";
import { failure, GatewayError } from "./errors";
import { asFiniteNumber } from "./values";

/**
 * When the allowance comes back. The document carries no period field, so the period is the
 * calendar month in UTC — the only reset the schema supports — and the refusal names the instant
 * rather than implying a rolling window the gateway cannot compute.
 */
export function allowanceResetAt(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

/** The unit `creditsResetAt` is stored in. */
function epochSeconds(instant: Date): number {
  return Math.floor(instant.getTime() / 1000);
}

/** A plan name from a document, or the default for a missing or nonsensical one. */
function planName(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : DEFAULT_PLAN;
}

/** The allowance's credit half, as one read of a document computes it. */
export interface CreditState {
  readonly creditsLimit: number;
  readonly creditsUsed: number;
  /** The instant this period's usage goes back to zero. */
  readonly creditsResetAt: Date;
  /** True when the stored period had already ended, so this read is the one that zeroed it. */
  readonly resetDue: boolean;
}

/** Credits as `data` and `now` describe them, with the monthly reset applied. */
function creditState(data: Record<string, unknown>, now: Date): CreditState {
  const definition = planDefinition(planName(data.plan));
  const creditsLimit = asFiniteNumber(data.creditsLimit) ?? definition.creditsLimit;
  const storedSeconds = asFiniteNumber(data.creditsResetAt);
  const storedReset = storedSeconds === null ? null : new Date(storedSeconds * 1000);
  const resetDue =
    definition.monthlyRefill && (storedReset === null || storedReset.getTime() <= now.getTime());
  return {
    creditsLimit,
    creditsUsed: resetDue ? 0 : asFiniteNumber(data.creditsUsed) ?? 0,
    // A plan that never refills has no period end to report; the calendar month boundary is
    // returned so `resets_at` is always an instant, and nothing is zeroed for it.
    creditsResetAt: resetDue || storedReset === null ? allowanceResetAt(now) : storedReset,
    resetDue,
  };
}

export interface AccountState extends Omit<CreditState, "resetDue"> {
  readonly disabled: boolean;
  readonly plan: string;
  readonly tokensUsed: number;
  readonly tokensLimit: number | null;
}

/**
 * The account as this gateway understands it, with the lazy monthly reset already applied — so the
 * numbers returned here are exactly the ones a request would be checked against, which is what makes
 * `GET /v1/account` worth calling.
 */
export async function readAccount(uid: string, now: Date = new Date()): Promise<AccountState> {
  const reference = getFirestore(adminApp()).doc(`users/${uid}`);
  const snapshot = await reference.get();
  const account = snapshot.data() ?? {};
  const credits = creditState(account, now);

  if (credits.resetDue) {
    // The reset is a write, not an adjustment in memory: the document is what the next request
    // reads, and a period that only the caller knows has ended would be recomputed forever. Only
    // the two fields the period owns are touched.
    await reference.set(
      { creditsUsed: 0, creditsResetAt: epochSeconds(credits.creditsResetAt) },
      { merge: true },
    );
  }

  return {
    disabled: account.disabled === true,
    plan: planName(account.plan),
    tokensUsed: asFiniteNumber(account.tokensUsed) ?? 0,
    tokensLimit: asFiniteNumber(account.tokensLimit),
    creditsLimit: credits.creditsLimit,
    creditsUsed: credits.creditsUsed,
    creditsResetAt: credits.creditsResetAt,
  };
}

/** What is left of the period's allowance. Never negative: an overshoot reads as zero, not a debt. */
export function creditsRemaining(account: AccountState): number {
  return Math.max(0, account.creditsLimit - account.creditsUsed);
}

/**
 * The refusals that do not depend on which model was asked for: a suspended account, and a token
 * allowance already spent. The credit check is separate because its answer needs the model's cost.
 */
export async function requireEntitlement(uid: string): Promise<AccountState> {
  const account = await readAccount(uid);

  if (account.disabled) {
    throw new GatewayError(
      failure(
        403,
        "permission_denied",
        "account_suspended",
        "This Orbital account is suspended, so the Orbital key is not available. Contact support " +
          "or use your own provider key instead.",
      ),
    );
  }

  if (account.tokensLimit !== null && account.tokensUsed >= account.tokensLimit) {
    throw new GatewayError(
      failure(
        402,
        "insufficient_quota",
        "allowance_exhausted",
        `This account's Orbital allowance is used up (${account.tokensUsed} of ` +
          `${account.tokensLimit} tokens). It resets at ${account.creditsResetAt.toISOString()}; ` +
          "use your own provider key until then.",
      ),
    );
  }

  return account;
}

/** A date written the way a person reads one, for the refusals that have to name a moment. */
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function plainInstant(instant: Date): string {
  const month = MONTHS[instant.getUTCMonth()] ?? "";
  const hour = String(instant.getUTCHours()).padStart(2, "0");
  const minute = String(instant.getUTCMinutes()).padStart(2, "0");
  return `${instant.getUTCDate()} ${month} ${instant.getUTCFullYear()} at ${hour}:${minute} UTC`;
}

/**
 * Whether the model may be asked for on this account's plan. The mechanism that would make a model
 * paid-only, and today the only thing it can refuse is a `paidOnly` entry on the free plan.
 */
export function requirePlanModel(account: AccountState, entry: CatalogueEntry): void {
  if (entryAvailableOnPlan(entry, account.plan)) return;
  throw new GatewayError(
    failure(
      403,
      "permission_denied",
      "model_not_available_on_plan",
      `The ${entry.id} model is not available on the ${account.plan} Orbital plan. Ask for another ` +
        "model, or use your own provider key.",
    ),
  );
}

/**
 * Whether this account can afford this prompt, refused before the request is forwarded so an account
 * out of credits never spends the Orbital key. The message names the model, what it costs and the
 * instant the allowance comes back, because "out of credits" without a date is a dead end.
 */
export function requireCredits(account: AccountState, entry: CatalogueEntry): void {
  const remaining = creditsRemaining(account);
  if (remaining >= entry.creditsPerPrompt) return;
  throw new GatewayError(
    failure(
      402,
      "insufficient_credits",
      "allowance_exhausted",
      `This account has ${remaining} of ${account.creditsLimit} Orbital credits left, and ` +
        `${entry.id} costs ${entry.creditsPerPrompt} credit` +
        `${entry.creditsPerPrompt === 1 ? "" : "s"} per prompt. The ${account.plan} plan's credits ` +
        `refill on ${plainInstant(account.creditsResetAt)} ` +
        `(${account.creditsResetAt.toISOString()}). Use your own provider key until then.`,
    ),
  );
}
