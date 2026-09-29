/**
 * Everything the gateway's behaviour is configured by, in one file, so the catalogue and the
 * limits are greppable and the tests can assert against the same numbers the proxy uses.
 */

import { DEFAULT_UPSTREAM_BASE_URL, UPSTREAM_BASE_URL_ENV, UPSTREAM_KEY_ENV } from "./environment";
import { failure, GatewayError } from "./errors";

/**
 * The version `/health` reports. Kept in step with `package.json` by the health test, which fails
 * if the two drift — a deployed gateway that cannot say which build it is makes a bug report
 * unanswerable.
 */
export const VERSION = "0.1.0";

/**
 * What one prompt costs the account, in credits. Three tiers only: a cheaper or smaller model costs
 * less to run and so less to ask for, and a frontier or high-context model costs more. This is the
 * whole credit model — there is no per-token arithmetic — so `credits_per_prompt` is exactly what a
 * successful prompt deducts, whatever the completion turns out to be (streamed or not, long or
 * short). 30 credits a month is therefore 60 prompts here, 30 at `1`, 15 at `2`.
 */
export type CreditCost = 0.5 | 1 | 2;

export interface CatalogueEntry {
  /** What the client asks for and sees. */
  readonly id: string;
  readonly ownedBy: string;
  /**
   * What the upstream is asked for. It is a separate field on purpose: the client's string is
   * only ever used to *look up* an entry, never sent upstream, so a renamed or aliased upstream
   * model is a change to this table rather than a change to the proxy.
   */
  readonly upstream: string;
  /** What one prompt of this model costs, from the three tiers above. */
  readonly creditsPerPrompt: CreditCost;
  /**
   * Whether the entry is reachable only on a plan that includes paid-only models. A `paidOnly`
   * model is omitted from `/v1/models` for a plan that does not, and refused by the plan check —
   * the one switch that would make a model paid-only without a code change elsewhere.
   */
  readonly paidOnly: boolean;
}

/**
 * The Orbital catalogue, and the source of truth for what a request may ask for: anything a client
 * sends that is not one of these ids is refused by name rather than rewritten, because silently
 * running a different model than the one asked for is worse than saying no.
 *
 * The ids are the upstream's (`GET {upstream}/models`, verified 2026-09-28). The upstream reports
 * **no pricing and no context length**, so the cost of a model is ours to maintain and cannot be
 * fetched; this table is the one editable place for it. Three tiers, and a model that belongs to
 * none of them is a bug in this file rather than a default — every cost is asserted against the
 * same table written out again in `test/credits.test.ts`, so a re-costing is a deliberate edit.
 *
 * Per model, adding or re-costing is a one-line edit in `TIERS`; making one paid-only is one id in
 * `PAID_ONLY`.
 */
const TIERS: readonly (readonly [CreditCost, readonly string[]])[] = [
  [
    0.5,
    [
      "deepseek-flash",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "glm-5.3-flash",
      "hy3",
      "longcat-2.0",
      "longcat-2.5-preview-free",
      "mimo-v2.6-flash",
      "minimax-m2.5",
      "muse-spark-1.2-contributor",
      "muse-spark-1.3-contributor",
      "qwen3.8-flash",
      "space-bunny-free",
    ],
  ],
  [
    1,
    [
      "deepseek-v4.1-flash",
      "glm-5.1",
      "glm-5.2",
      "glm-5.3",
      "grok-4.6",
      "hy4-preview",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "mimo-v2.6-pro",
      "minimax-m2.7",
      "omen-alpha",
      "qwen3.6-plus",
      "qwen3.7-plus",
    ],
  ],
  [
    2,
    [
      "deepseek-v4-pro",
      "grok-4.7",
      "gpt-5.6-luna",
      "gpt-6-luna",
      "kimi-k3",
      "minimax-m3",
      "qwen3.7-max",
      "qwen3.8-max",
    ],
  ],
];

/**
 * Models a paid plan is required for. **Empty on purpose**: no paid plan exists, and seeding a
 * paid-only model now would leave it unreachable — so every model stays available on the free plan
 * until a paid plan is added to `PLANS` below. The mechanism is what must exist, not a locked door.
 */
const PAID_ONLY: readonly string[] = [];

export const CATALOGUE: readonly CatalogueEntry[] = TIERS.flatMap(([creditsPerPrompt, ids]) =>
  ids.map((id) => ({
    id,
    ownedBy: "orbital",
    upstream: id,
    creditsPerPrompt,
    paidOnly: PAID_ONLY.includes(id),
  })),
);

/** The catalogue as prose, for the refusals that have to say what *is* allowed. */
export const ALLOWED_MODELS = CATALOGUE.map((entry) => entry.id).join(", ");

/**
 * A plan's credit terms.
 *
 * Only the free plan is seeded: there is no paid plan yet, and writing its price into this file
 * would be inventing a decision nobody made. The mechanism for one is here all the same — a paid
 * plan is a second entry with its own `creditsLimit`, `monthlyRefill: false` because a paid plan is
 * not expected to wait for the 1st, and `includesPaidOnlyModels: true` so entries marked `paidOnly`
 * become reachable. That edit is this table's, in the same file as the costs.
 */
export interface PlanDefinition {
  /** How many credits one period allows. */
  readonly creditsLimit: number;
  /** Whether the allowance comes back on the 1st of each month. Nothing ever rolls over. */
  readonly monthlyRefill: boolean;
  /** Whether this plan may use catalogue entries marked `paidOnly`. */
  readonly includesPaidOnlyModels: boolean;
}

/** The plan an account document that names no plan (or an unknown one) is treated as. */
export const DEFAULT_PLAN = "free";

/** The free plan: 30 credits a calendar month, no rollover, nothing locked away yet. */
const FREE_PLAN: PlanDefinition = { creditsLimit: 30, monthlyRefill: true, includesPaidOnlyModels: false };

export const PLANS: Readonly<Record<string, PlanDefinition>> = { free: FREE_PLAN };

/** The terms of `plan`, or the free plan's when the document names a plan this build does not know. */
export function planDefinition(plan: string): PlanDefinition {
  return PLANS[plan] ?? FREE_PLAN;
}

/** Whether a plan may use a catalogue entry: only a `paidOnly` entry on a plan that excludes them. */
export function entryAvailableOnPlan(entry: CatalogueEntry, plan: string): boolean {
  return !entry.paidOnly || planDefinition(plan).includesPaidOnlyModels;
}

/** The catalogue as one plan sees it — the list `/v1/models` answers with. */
export function catalogueFor(plan: string): readonly CatalogueEntry[] {
  return CATALOGUE.filter((entry) => entryAvailableOnPlan(entry, plan));
}

/**
 * The ceiling this gateway applies to `max_tokens`, an abuse floor rather than a user-facing
 * setting: the Orbital key is spent by whoever holds an account, so one request cannot ask for an
 * unbounded completion. A request at or below the ceiling is forwarded untouched.
 */
export const MAX_TOKENS_CLAMP = 8192;

/**
 * How many requests one account may have open on one instance at once. Best-effort by
 * construction: the counter lives in this instance's memory and Cloud Functions runs many
 * instances, so this is a floor against a runaway client, not a rate limit. A durable, global
 * limit needs shared state and is a later decision.
 */
export const MAX_IN_FLIGHT_PER_ACCOUNT = 4;

/**
 * How much of a response is inspected for `usage`. Accounting is best-effort and must not turn a
 * long completion into a memory problem, so past this point the gateway stops counting rather
 * than buffering the rest.
 */
export const MAX_ACCOUNTING_BYTES = 2 * 1024 * 1024;

/** How much of an upstream's own words is kept when explaining a refusal. */
export const MAX_DETAIL_CHARS = 300;

/** How much of an upstream error page is read at all. */
export const MAX_ERROR_BODY_CHARS = 8192;

/** How many tokens one character of a request or completion is estimated to be worth. */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Where the upstream lives. Read per request, not at import time, because the emulator suite, the
 * tests and production all set it differently and the same code has to run under all three.
 */
export function upstreamBaseUrl(): string {
  const configured = process.env[UPSTREAM_BASE_URL_ENV]?.trim();
  const base = configured && configured.length > 0 ? configured : DEFAULT_UPSTREAM_BASE_URL;
  return base.replace(/\/+$/, "");
}

/**
 * The Orbital key.
 *
 * `index.ts` binds it with `defineSecret`, which is what makes the Cloud Functions runtime inject
 * it as this environment variable; the emulator resolves the same variable from `gateway/.env`
 * files. So reading the environment is the one path that is identical in production, in the
 * emulator and in a test — and it is the only place in this package the key is read.
 */
export function upstreamKey(): string {
  const key = process.env[UPSTREAM_KEY_ENV]?.trim();
  if (!key) {
    throw new GatewayError(
      failure(
        500,
        "server_error",
        "upstream_key_missing",
        `The gateway has no upstream key. Bind the ${UPSTREAM_KEY_ENV} secret to the function ` +
          "(see gateway/README.md); set it in gateway/.env.local when running the emulator.",
      ),
    );
  }
  return key;
}
