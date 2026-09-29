/**
 * The provider profiles a run may talk to, and the credential each one holds.
 *
 * The backend is the only place a key exists: every shape here carries whether there is one and
 * the last few characters it ends with — never the key. A profile is created from a preset the
 * backend serves, so this module hardcodes no provider list and a provider added there appears
 * here with no client change.
 */

import { apiGet, apiSend, errorMessage } from "@/lib/api";
import { auth, usingAuthEmulator } from "@/lib/firebase";

/** The shapes a profile takes, matching the backend's `ProviderKind`. */
export type ProviderKind = "openai-compatible" | "orbital" | "local";

/** One provider the picker offers, with the values a new profile starts from. */
export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  /**
   * Prefilled into the new profile and editable there. Null for the one preset whose URL is the
   * client's to compute — `orbital`, whose address depends on this build's Firebase project and on
   * whether it uses the emulator — so the form asks `orbitalBaseUrl` instead.
   */
  baseUrl: string | null;
  model: string;
  /** False for an endpoint that answers without a key, which is the field the form hides. */
  apiKeyRequired: boolean;
}

/** Where a profile's model list came from: the endpoint's own answer, or its preset's curation. */
export type ModelSource = "provider" | "preset";

/** A stored profile as the API returns it. There is no field here a key could travel in. */
export interface ProviderProfile {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  /**
   * What the connect step stored: the endpoint's own models when it listed them, the preset's
   * curated seed when it would not, and empty until connect has run. `modelsSource` says which —
   * the two are told apart because a curated seed is not a claim about what this key reaches.
   */
  models: string[];
  /** Epoch seconds, or null when nothing has been connected. */
  modelsFetchedAt: number | null;
  modelsSource: ModelSource | null;
  apiKeySet: boolean;
  /** The last four characters, enough to tell two keys apart; null when there is no key. */
  apiKeyHint: string | null;
  active: boolean;
  createdAt: number;
}

/** The whole list, which is what every profile mutation returns. */
export interface ProviderList {
  profiles: ProviderProfile[];
  /** The profile a run talks to, or null when the user has configured none. */
  activeId: string | null;
  /**
   * Something to tell the user about an edit that nevertheless succeeded — today, that a key
   * entered for one host is about to be sent to another. Absent or null when there is nothing to
   * say; the runtime always sends the field.
   */
  notice?: string | null;
}

/** The outcome of one authenticated call to a profile's endpoint. */
export interface ProviderTestResult {
  /** False for a refused key as well as an unreachable endpoint; `detail` carries the words. */
  ok: boolean;
  detail: string;
  models: string[];
}

/**
 * What the connect step found, and therefore what the picker can offer.
 *
 * Always HTTP 200, because every outcome is one of the answers: a refused key, an endpoint that
 * will not list its models and has no curated seed, and a full list are all things the user acts
 * on rather than transport failures.
 */
export interface ProviderConnectResult {
  ok: boolean;
  /** The endpoint's own words when it refused, or a sentence about where the list came from. */
  detail: string;
  models: string[];
  /** Never absent: a preset with nothing curated still reports `"preset"`. */
  source: ModelSource;
}

/** What a profile has stored — read from the runtime with no network call of its own. */
export interface ProviderModelsResult {
  models: string[];
  /** Null on a profile that has never been connected, which is not the same as an empty list. */
  source: ModelSource | null;
  fetchedAt: number | null;
}

/** A new profile. `apiKey` is omitted for an endpoint that needs none. */
export interface ProviderDraft {
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/** A partial edit. An omitted field is left as it was; `apiKey: ""` clears the stored key. */
export interface ProviderPatch {
  label?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

const path = (id: string) => `/api/providers/${encodeURIComponent(id)}`;

/**
 * Host and port of an endpoint, or the raw value when it is not a URL.
 *
 * Shown instead of the full base URL wherever the provider's name is already on screen — the host
 * is the part that says *where* a key would be sent.
 */
export function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** The kind the gateway is offered as, and the one whose "key" is the account rather than a paste. */
export const ORBITAL_KIND: ProviderKind = "orbital";

/**
 * Whether a profile of this kind cannot answer without a key the user pasted.
 *
 * False for `local`, which is what the kind means, and false for `orbital`: its key is the signed-in
 * account's ID token, which `useOrbitalProvider` refreshes and stores, so there is no field to fill
 * in and no key to lose.
 */
export function kindNeedsKey(kind: ProviderKind): boolean {
  return kind !== "local" && kind !== ORBITAL_KIND;
}

/**
 * The Orbital gateway's base URL for this build, or null when the app has no Firebase config.
 *
 * Two shapes, and the build decides which: the emulator's, which carries the project id and the
 * region in the path, and the deployed one, which is `us-central1` because the gateway pins that
 * region. Derived from the client's own configuration rather than stored, so the profile points at
 * the project the signed-in account actually belongs to — and so nothing has to be typed.
 */
export function orbitalBaseUrl(): string | null {
  const projectId = auth?.app.options.projectId;
  if (!projectId) return null;
  return usingAuthEmulator
    ? `http://127.0.0.1:5001/${projectId}/us-central1/orbital/v1`
    : `https://us-central1-${projectId}.cloudfunctions.net/orbital/v1`;
}

/** One model the gateway serves, with what a prompt costs against the plan's credits. */
export interface OrbitalModel {
  id: string;
  /** Credits one prompt costs: 0.5, 1 or 2. The gateway decides, so nothing here guesses. */
  creditsPerPrompt: number;
}

/** What the account may spend, as the gateway reports it. */
export interface OrbitalAccount {
  plan: string;
  credits: {
    limit: number;
    used: number;
    remaining: number;
    /** Epoch seconds at which the allowance refills. */
    resetsAt: number;
  };
}

/**
 * One authenticated GET against the gateway, as JSON.
 *
 * The token is the profile's key: the gateway verifies it and holds the Orbital key itself, so
 * nothing secret crosses and nothing has to be typed. A refusal comes back as the gateway's own
 * words — an account out of allowance, a token the project will not verify — and is thrown here so
 * the caller can show it verbatim, which is the same contract the connection test has.
 */
async function gatewayJson(baseUrl: string, token: string, path: string): Promise<unknown> {
  const url = `${baseUrl.replace(/\/+$/, "")}/${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch (cause) {
    // No response at all, so there are no gateway words to show: say where it could not be reached.
    throw new Error(
      `Cannot reach the Orbital gateway at ${endpointHost(baseUrl)}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  let payload: unknown = null;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    // An empty or non-JSON body carries no message; the status below is what there is to report.
  }
  if (!response.ok) {
    // The refusal body is OpenAI-shaped: `{ error: { message, type, code } }`.
    const error = (payload as { error?: { message?: unknown } } | null)?.error;
    throw new Error(
      typeof error?.message === "string" && error.message !== ""
        ? error.message
        : `${response.status} ${response.statusText}`,
    );
  }
  return payload;
}

/**
 * The models the gateway serves, each with what a prompt costs.
 *
 * A missing or non-numeric `credits_per_prompt` is read as 0 rather than dropped: the cost is a
 * display detail, and hiding a model the plan allows because its price was unreadable would be the
 * picker inventing a restriction.
 */
export async function orbitalModels(baseUrl: string, token: string): Promise<OrbitalModel[]> {
  const payload = await gatewayJson(baseUrl, token, "models");
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id === "") return [];
    const cost = (entry as { credits_per_prompt?: unknown } | null)?.credits_per_prompt;
    return [{ id, creditsPerPrompt: typeof cost === "number" ? cost : 0 }];
  });
}

/**
 * What the account has left this month.
 *
 * The plan and the credit balance are the gateway's to state, so they are read rather than derived:
 * the free plan's 30 a month and its monthly reset are a policy the server owns, and a client that
 * recomputed them would be the second place that policy lives.
 */
export async function orbitalAccount(baseUrl: string, token: string): Promise<OrbitalAccount> {
  const payload = await gatewayJson(baseUrl, token, "account");
  const account = payload as Partial<OrbitalAccount> | null;
  const credits = account?.credits ?? { limit: 0, used: 0, remaining: 0, resetsAt: 0 };
  return {
    plan: typeof account?.plan === "string" ? account.plan : "unknown",
    credits: {
      limit: typeof credits.limit === "number" ? credits.limit : 0,
      used: typeof credits.used === "number" ? credits.used : 0,
      remaining: typeof credits.remaining === "number" ? credits.remaining : 0,
      resetsAt: typeof credits.resetsAt === "number" ? credits.resetsAt : 0,
    },
  };
}

/** What a fresh Orbital setup produced, before anything is written. */
export interface OrbitalDraft {
  /**
   * The profile to create — the URL this build derives, the catalogue's first model, and the
   * account's ID token as the key — or null when the URL cannot be derived at all, which only
   * happens for a build with no Firebase configuration.
   */
  draft: ProviderDraft | null;
  /** The gateway's own words when the catalogue call did not answer; null when it did. */
  catalogueDetail: string | null;
}

/**
 * The profile an Orbital setup starts from: nothing pasted, and nothing guessed that can be asked.
 *
 * The URL is the client's to compute, so it is computed here rather than taken from the preset. The
 * model is the first one the gateway's own catalogue names, asked with the signed-in account's ID
 * token; when that call does not answer the preset's default is used instead and the gateway's words
 * are handed back, because the reason the catalogue was refused (a suspended account, an allowance
 * spent, a token the project will not verify) is the thing the user has to see.
 *
 * The token is carried in the draft so the profile is complete the moment it is created, rather than
 * waiting for the background sync to catch up — that sync is what keeps it current afterwards.
 */
export async function orbitalDraft(preset: ProviderPreset): Promise<OrbitalDraft> {
  const baseUrl = orbitalBaseUrl();
  if (baseUrl === null) {
    return {
      draft: null,
      catalogueDetail:
        "This build has no Firebase configuration, so the Orbital gateway's address cannot be derived.",
    };
  }
  const token = (await auth?.currentUser?.getIdToken()) ?? null;
  let catalogue: OrbitalModel[] = [];
  let catalogueDetail: string | null = null;
  if (token === null) {
    catalogueDetail = "The signed-in account has no ID token to present to the gateway yet.";
  } else {
    try {
      catalogue = await orbitalModels(baseUrl, token);
    } catch (cause: unknown) {
      catalogueDetail = errorMessage(cause);
    }
  }
  const draft: ProviderDraft = {
    label: preset.label,
    kind: preset.kind,
    baseUrl,
    model: catalogue[0]?.id ?? preset.model.trim(),
  };
  // An empty string would clear a stored key; this kind's key is the account's token, not a choice.
  if (token !== null) draft.apiKey = token;
  return { draft, catalogueDetail };
}

/**
 * Whether a model id is something other than a chat model.
 *
 * A **heuristic**, and it has to be: no provider here publishes a modality, so the id is all there
 * is to go on. LM Studio lists the embedding models it has loaded beside the chat ones, and one
 * offered in a picker would fail on the first completion rather than on sight. The three
 * substrings are what embedding ids in the wild carry (`…-embed-…`, `bge-…`, `e5-…`).
 *
 * It filters what is *offered*, nothing else: the picker lets a model be typed by hand, so a chat
 * model this misjudges is one keystroke away from working.
 */
export function isEmbeddingModel(id: string): boolean {
  const lower = id.toLowerCase();
  return lower.includes("embed") || lower.includes("bge") || lower.includes("e5");
}

export const providers = {
  /** Every configured endpoint, most recently created last. */
  list: () => apiGet<ProviderList>("/api/providers"),

  /** The providers a profile can be created from. Served, so the form hardcodes none. */
  presets: async (): Promise<ProviderPreset[]> =>
    (await apiGet<{ presets: ProviderPreset[] }>("/api/providers/presets")).presets,

  /** Add a profile. The first one becomes active; the list comes back either way. */
  create: (draft: ProviderDraft) => apiSend<ProviderList>("/api/providers", draft),

  update: (id: string, patch: ProviderPatch) => apiSend<ProviderList>(path(id), patch, "PATCH"),

  remove: (id: string) => apiSend<ProviderList>(path(id), undefined, "DELETE"),

  /** Make this the profile every run talks to. */
  activate: (id: string) => apiSend<ProviderList>(`${path(id)}/activate`),

  /**
   * Ask the profile's endpoint what it serves, and store the answer.
   *
   * This is the step that turns a pasted URL and key into a list to choose from. A refused key
   * arrives as `ok: false` with the endpoint's own words and nothing stored — which is the answer,
   * not a failure of the call — and everything else is HTTP 200 by contract.
   */
  connect: (id: string) => apiSend<ProviderConnectResult>(`${path(id)}/connect`),

  /**
   * What this profile has stored, read from the runtime with no network call of its own.
   *
   * A dropdown opening is not a reason to make the provider answer again: it already answered, and
   * one that is slow, rate-limiting or off must not be able to empty a list the user can pick from.
   */
  models: (id: string) => apiGet<ProviderModelsResult>(`${path(id)}/models`),

  /**
   * One authenticated call to the profile's endpoint.
   *
   * A refused key arrives as `ok: false` with the endpoint's own complaint, and the request still
   * succeeds — "your key was rejected" is the answer, not a failure of the call.
   */
  test: (id: string) => apiSend<ProviderTestResult>(`${path(id)}/test`),
};
