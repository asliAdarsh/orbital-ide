/**
 * The provider dialog: which endpoint runs talk to, shown over the dashboard rather than instead
 * of it.
 *
 * It replaces the full-screen gate on purpose. Browsing projects and running terminal commands need
 * no provider at all, and a first-run *screen* made that choice for the user by hiding the whole
 * application behind a form. A dialog over the dashboard offers the same setup while leaving the
 * app behind it usable, and "Later" is a real answer rather than a trap.
 *
 * Three ways in, because the three cost the user different things:
 *
 * * **Provider and key** — pick an endpoint, paste its key, press Connect, and only then is there a
 *   model list to choose from. The list is what the provider itself answered; a key it refuses
 *   shows its own words and nothing is stored, because a list from a refused key would be a claim
 *   about what that key can reach.
 * * **Orbital** — nothing is pasted. The account's own gateway, its key held server-side, spending
 *   the plan's credits at a per-model cost the gateway states.
 * * **Local** — LM Studio or Ollama on this machine, no key at all.
 *
 * A profile is created before it is connected on purpose: a wrong key is fixable by pressing
 * Connect again, while refusing to store the profile would throw away the endpoint the user just
 * chose. Re-pointing an existing profile is the same flow — a profile already standing at the typed
 * URL is edited rather than duplicated, which is what makes a key the runtime migrated in from
 * `.env` a starting point instead of a second, shadowing copy.
 */

import { useEffect, useState } from "react";
import { Check, ShieldCheck } from "lucide-react";

import { errorMessage } from "@/lib/api";
import { auth } from "@/lib/firebase";
import {
  endpointHost,
  isEmbeddingModel,
  ORBITAL_KIND,
  orbitalAccount,
  orbitalBaseUrl,
  orbitalDraft,
  orbitalModels,
  type OrbitalAccount,
  type OrbitalModel,
  type ProviderConnectResult,
  type ProviderDraft,
  type ProviderPatch,
  type ProviderPreset,
} from "@/lib/providers";
import { cn } from "@/lib/utils";
import { useProviders, type ProvidersApi } from "@/hooks/useProviders";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const FIELD = "h-7 font-mono text-2xs";
const LABEL = "text-2xs text-muted-foreground";

/** Past this many models the chooser grows a filter box; below it a filter is longer than the list. */
const FILTER_THRESHOLD = 8;

/** Trailing slashes are not part of an address, so two that differ only there are one endpoint. */
const withoutSlash = (value: string) => value.trim().replace(/\/+$/, "");

export interface ProviderDialogProps {
  /**
   * Close it. The caller records that this machine has been asked, so it is not asked again — which
   * is the whole point of "Later" being an answer rather than a delay.
   */
  onDismiss(): void;
}

/**
 * A list of model ids to choose from, with a filter that doubles as a way to name one by hand.
 *
 * The hand-typed row is not a concession: a provider serves whatever it happens to have loaded, an
 * id this client has never heard of is normal, and a picker that could only offer what it already
 * knew would make a working endpoint unusable.
 */
function ModelChooser({
  models,
  value,
  onChange,
}: {
  /** Already filtered: embedding ids are removed before they reach here. */
  models: string[];
  value: string;
  onChange(model: string): void;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const visible = needle === "" ? models : models.filter((id) => id.toLowerCase().includes(needle));
  const typed = filter.trim();
  const offerTyped = typed !== "" && !models.includes(typed);

  const row = (id: string, label: string) => (
    <button
      key={id}
      type="button"
      role="radio"
      aria-checked={value === id}
      title={label}
      onClick={() => onChange(id)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-chrome-raised",
        value === id ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Check className={cn("size-3 shrink-0", value === id ? "opacity-100" : "opacity-0")} />
      <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
    </button>
  );

  return (
    <div className="flex flex-col gap-1">
      {models.length > FILTER_THRESHOLD ? (
        <Input
          value={filter}
          aria-label="Filter models"
          placeholder="Filter, or type a model id"
          onChange={(event) => setFilter(event.target.value)}
          className={FIELD}
        />
      ) : null}
      <div
        role="radiogroup"
        aria-label="Model"
        className="max-h-56 overflow-y-auto rounded border border-border p-1"
      >
        {visible.map((id) => row(id, id))}
        {offerTyped ? row(typed, `Use “${typed}”`) : null}
        {visible.length === 0 && !offerTyped ? (
          <p className="px-1.5 py-1 text-muted-foreground">Nothing listed to choose from.</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Pick an endpoint, give it what it needs, Connect, then choose from what it answered.
 *
 * One component serves both the keyed providers and the local ones, because the flow is the same
 * and only the field differs: a local endpoint's "no key needed" is written where the key field
 * would be, and the key is never sent for one.
 */
function EndpointSetup({
  api,
  presets,
  onDone,
}: {
  api: ProvidersApi;
  /** The presets this section offers, in the order the runtime served them. */
  presets: ProviderPreset[];
  onDone(): void;
}) {
  const [presetId, setPresetId] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [profileId, setProfileId] = useState<string | null>(null);
  const [result, setResult] = useState<ProviderConnectResult | null>(null);
  const [chosen, setChosen] = useState("");
  // The connect step's own complaint, kept apart from `api.error`: a refused key is an answer, and
  // it has to be shown word for word rather than summarised.
  const [refusal, setRefusal] = useState<string | null>(null);

  const preset = presets.find((candidate) => candidate.id === presetId) ?? null;
  const needsKey = preset?.apiKeyRequired ?? false;
  // A profile already standing at this address is the one Connect edits, so it is also what makes a
  // blank key field a real choice ("keep the stored key") rather than an unfinished form.
  const standing =
    withoutSlash(baseUrl) === ""
      ? null
      : (api.profiles.find((profile) => withoutSlash(profile.baseUrl) === withoutSlash(baseUrl)) ??
        null);
  const complete =
    preset !== null && baseUrl.trim() !== "" && (!needsKey || apiKey.trim() !== "" || standing !== null);

  const choose = (next: ProviderPreset) => {
    setPresetId(next.id);
    setBaseUrl(next.baseUrl ?? "");
    setApiKey("");
    setProfileId(null);
    setResult(null);
    setRefusal(null);
    setChosen(next.model);
  };

  const connect = async () => {
    if (preset === null) return;
    setRefusal(null);
    setResult(null);

    let id = standing?.id ?? null;
    if (id !== null) {
      const patch: ProviderPatch = { baseUrl: baseUrl.trim() };
      // Blank means "keep the stored key", which is what makes re-connecting a keyless edit safe.
      if (apiKey.trim() !== "") patch.apiKey = apiKey.trim();
      if (!(await api.update(id, patch))) return;
    } else {
      const draft: ProviderDraft = {
        label: preset.label,
        kind: preset.kind,
        baseUrl: baseUrl.trim(),
        model: preset.model,
      };
      // Omitted entirely for an endpoint that needs none: the runtime stores a keyless profile,
      // which is the only honest shape for a loopback address.
      if (needsKey && apiKey.trim() !== "") draft.apiKey = apiKey.trim();
      const added = await api.create(draft);
      if (added === null) return;
      id = added.id;
    }
    setProfileId(id);

    const answer = await api.connect(id);
    // Null means the call never landed at all, which `api.error` reports.
    if (answer === null) return;
    setResult(answer);
    if (!answer.ok) {
      setRefusal(answer.detail);
      return;
    }
    // Embedding ids are hidden from the chooser — see `isEmbeddingModel` — and the chooser's filter
    // is what lets one be named anyway.
    setChosen(answer.models.filter((model) => !isEmbeddingModel(model))[0] ?? "");
  };

  const finish = async (id: string) => {
    // Reachable only after a connect that produced this id; the guard is here so a missing one is
    // a no-op rather than an activate request against an empty path.
    if (id === "") return;
    const model = chosen.trim();
    const profile = api.profiles.find((candidate) => candidate.id === id) ?? null;
    if (model !== "" && profile !== null && model !== profile.model) {
      if (!(await api.update(id, { model }))) return;
    }
    if (!(await api.activate(id))) return;
    onDone();
  };

  const offered = result?.ok === true ? result.models.filter((model) => !isEmbeddingModel(model)) : [];
  const hidden = result?.ok === true ? result.models.length - offered.length : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex max-h-48 flex-col overflow-y-auto rounded border border-border">
        {presets.map((candidate) => {
          const selected = candidate.id === presetId;
          return (
            <button
              key={candidate.id}
              type="button"
              aria-pressed={selected}
              // Switching after a profile exists would leave it under another endpoint's name, and
              // the edit API cannot change a profile's kind.
              disabled={api.busy || (profileId !== null && !selected)}
              onClick={() => choose(candidate)}
              className={cn(
                "flex items-start gap-2 border-b border-border px-2.5 py-2 text-left transition-colors last:border-b-0 disabled:opacity-40",
                selected ? "bg-primary/10" : "hover:bg-chrome-raised",
              )}
            >
              <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {selected ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={cn("truncate text-xs", selected ? "text-foreground" : "text-muted-foreground")}>
                  {candidate.label}
                </span>
                <span className="truncate font-mono text-2xs text-muted-foreground">
                  {candidate.baseUrl ?? ""} · {candidate.model} ·{" "}
                  {candidate.apiKeyRequired ? "API key required" : "No key needed"}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {preset === null ? (
        <p className={LABEL}>Pick a provider above to fill in its endpoint.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="grid grid-cols-[6rem_1fr] items-center gap-3">
            <span className={LABEL}>Base URL</span>
            <Input
              className={FIELD}
              value={baseUrl}
              disabled={api.busy}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>

          {needsKey ? (
            <label className="grid grid-cols-[6rem_1fr] items-center gap-3">
              <span className={LABEL}>API key</span>
              <Input
                type="password"
                autoComplete="off"
                className={FIELD}
                placeholder={standing === null ? "paste the key" : "leave blank to keep the stored key"}
                value={apiKey}
                disabled={api.busy}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
          ) : (
            <div className="grid grid-cols-[6rem_1fr] items-center gap-3">
              <span className={LABEL}>API key</span>
              <span className={LABEL}>
                Not needed: this endpoint answers on your own machine or network.
              </span>
            </div>
          )}

          {standing !== null ? (
            <p className={LABEL}>
              A profile already stands at this address ({standing.label}); Connect edits it rather
              than adding a second one.
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            <Button size="sm" loading={api.busy} disabled={!complete} onClick={() => void connect()}>
              Connect
            </Button>
            <span className={LABEL}>
              Asks the endpoint what it serves. Nothing is stored until it answers.
            </span>
          </div>
        </div>
      )}

      {result !== null && result.ok ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <p className={LABEL}>
            {hidden > 0
              ? `${offered.length} of ${result.models.length} models — ${hidden} embedding ${
                  hidden === 1 ? "id is" : "ids are"
                } hidden as not chat models (a heuristic; type one to use it anyway).`
              : `${offered.length} models from ${endpointHost(baseUrl)}.`}
          </p>
          {result.source === "preset" ? (
            // The runtime's own words: a curated list is a different claim from the provider's, and
            // the difference is exactly what the user is choosing on.
            <span className="font-mono text-2xs leading-relaxed text-phase-test">{result.detail}</span>
          ) : null}
          <ModelChooser models={offered} value={chosen} onChange={setChosen} />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              loading={api.busy}
              disabled={chosen.trim() === ""}
              onClick={() => void finish(profileId ?? "")}
            >
              Use this model
            </Button>
            <span className={LABEL}>
              {chosen.trim() === "" ? "Choose one to carry on." : `Runs will use ${chosen.trim()}.`}
            </span>
          </div>
        </div>
      ) : null}

      {refusal !== null ? (
        <div className="flex flex-col gap-1 border border-phase-test/40 bg-phase-test/5 p-2">
          <span className={LABEL}>
            The profile is saved, but the endpoint refused it:
          </span>
          {/* The endpoint's own words, unedited: they name the key, the field or the URL that is
              wrong, and a paraphrase would only lose that. */}
          <span className="font-mono text-2xs leading-relaxed text-phase-test">{refusal}</span>
        </div>
      ) : api.error !== null ? (
        <span className="font-mono text-2xs leading-relaxed text-phase-test">{api.error}</span>
      ) : null}

      {api.notice !== null ? <p className={LABEL}>{api.notice}</p> : null}
    </div>
  );
}

/**
 * The account's own gateway: no key, and a price per prompt the gateway itself states.
 *
 * Everything shown here is asked of the gateway rather than assumed — the plan, what is left of the
 * allowance, when it refills, and what each model costs — because the free allowance and its reset
 * are a policy the server owns. When the gateway does not answer, its own words are shown and no
 * balance is invented.
 */
function OrbitalSetup({
  api,
  preset,
  onDone,
}: {
  api: ProvidersApi;
  preset: ProviderPreset;
  onDone(): void;
}) {
  const [account, setAccount] = useState<OrbitalAccount | null>(null);
  const [catalogue, setCatalogue] = useState<OrbitalModel[]>([]);
  const [detail, setDetail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chosen, setChosen] = useState(preset.model);

  const baseUrl = orbitalBaseUrl();

  useEffect(() => {
    let live = true;
    const read = async () => {
      const token = (await auth?.currentUser?.getIdToken()) ?? null;
      if (baseUrl === null || token === null) {
        if (live) {
          setDetail(
            baseUrl === null
              ? "This build has no Firebase configuration, so the gateway's address cannot be derived."
              : "The signed-in account has no ID token to present to the gateway yet.",
          );
          setLoading(false);
        }
        return;
      }
      try {
        const [next, models] = await Promise.all([
          orbitalAccount(baseUrl, token),
          orbitalModels(baseUrl, token),
        ]);
        if (!live) return;
        setAccount(next);
        setCatalogue(models.filter((model) => !isEmbeddingModel(model.id)));
        setDetail(null);
      } catch (cause: unknown) {
        if (live) setDetail(errorMessage(cause));
      } finally {
        if (live) setLoading(false);
      }
    };
    void read();
    return () => {
      live = false;
    };
  }, [baseUrl]);

  const setUp = async () => {
    // The draft is what decides a new Orbital profile everywhere else too — the URL this build can
    // derive, and the model the gateway's catalogue leads with — so it is used rather than rebuilt.
    const { draft, catalogueDetail } = await orbitalDraft(preset);
    if (catalogueDetail !== null) setDetail(catalogueDetail);
    if (draft === null) return;

    const standing = api.profiles.find((profile) => profile.kind === ORBITAL_KIND) ?? null;
    let id: string;
    if (standing !== null) {
      const patch: ProviderPatch = { baseUrl: draft.baseUrl };
      if (draft.apiKey !== undefined) patch.apiKey = draft.apiKey;
      // Only when the user picked one: otherwise the catalogue's own lead stands.
      if (chosen.trim() !== "") patch.model = chosen.trim();
      if (!(await api.update(standing.id, patch))) return;
      id = standing.id;
    } else {
      const added = await api.create(
        chosen.trim() === "" ? draft : { ...draft, model: chosen.trim() },
      );
      if (added === null) return;
      id = added.id;
    }

    // Stores the gateway's own list on the profile, so the composer can offer it without asking
    // the gateway again.
    const answer = await api.connect(id);
    if (!(await api.activate(id))) return;

    if (answer !== null && answer.ok && catalogueDetail === null) {
      onDone();
      return;
    }
    // The profile is made either way — it points at the gateway, and the gateway being down is not
    // a reason to throw the choice away. What is *not* made is a model list, so the dialog stays
    // open on the reason: the words above are the gateway's own, and pressing again retries.
    if (answer !== null && !answer.ok) setDetail(answer.detail);
  };

  const reset = account !== null && account.credits.resetsAt > 0 ? new Date(account.credits.resetsAt * 1000) : null;

  return (
    <div className="flex flex-col gap-3">
      <p className={LABEL}>
        Runs use Orbital&rsquo;s key through your account, against the plan&rsquo;s credits. Nothing
        is pasted, and Orbital&rsquo;s key never reaches this machine.
      </p>

      {baseUrl !== null ? (
        <p className="font-mono text-2xs text-muted-foreground">{baseUrl}</p>
      ) : null}

      {loading ? (
        <p className={LABEL}>Asking the gateway what this account may use…</p>
      ) : account !== null ? (
        <div className="flex flex-col gap-1 rounded border border-border bg-chrome-sunken p-2">
          <div className="flex flex-wrap items-baseline gap-x-2 font-mono text-2xs">
            <span className="text-foreground">{account.plan} plan</span>
            <span className="text-muted-foreground">
              {account.credits.remaining} of {account.credits.limit} credits left
            </span>
            {reset !== null ? (
              <span className="text-muted-foreground">refills {reset.toLocaleString()}</span>
            ) : null}
          </div>
          <span className={LABEL}>
            A prompt costs the model&rsquo;s own price, charged against that balance.
          </span>
        </div>
      ) : null}

      {catalogue.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className={LABEL}>Available models, with what one prompt costs</span>
          <div
            role="radiogroup"
            aria-label="Orbital model"
            className="max-h-56 overflow-y-auto rounded border border-border p-1"
          >
            {catalogue.map((model) => (
              <button
                key={model.id}
                type="button"
                role="radio"
                aria-checked={chosen === model.id}
                onClick={() => setChosen(model.id)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-chrome-raised",
                  chosen === model.id ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <Check
                  className={cn("size-3 shrink-0", chosen === model.id ? "opacity-100" : "opacity-0")}
                />
                <span className="min-w-0 flex-1 truncate font-mono">{model.id}</span>
                <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                  {model.creditsPerPrompt} credit{model.creditsPerPrompt === 1 ? "" : "s"}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {detail !== null ? (
        <div className="flex flex-col gap-1 border border-phase-test/40 bg-phase-test/5 p-2">
          <span className={LABEL}>
            The gateway did not answer with what this account may use, so there is no list to pick
            from. Pressing Use Orbital still creates the profile and makes it the one runs use:
          </span>
          {/* Its own words, unedited — the out-of-credits message is a 402 body that names the
              model's cost and the refill instant, and rewording it would lose both. */}
          <span className="font-mono text-2xs leading-relaxed text-phase-test">{detail}</span>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button size="sm" loading={api.busy} onClick={() => void setUp()}>
          Use Orbital
        </Button>
        <span className={LABEL}>
          {catalogue.length > 0 && chosen.trim() !== ""
            ? `Runs will use ${chosen.trim()}.`
            : "Creates the profile and makes it the one runs use."}
        </span>
      </div>
    </div>
  );
}

export function ProviderDialog({ onDismiss }: ProviderDialogProps) {
  const api = useProviders();
  // The three ways, in the order they cost the user: nothing, an account, then a paste.
  const [way, setWay] = useState<"provider" | "orbital" | "local">("provider");

  const keyed = api.presets.filter(
    (preset) => preset.kind !== ORBITAL_KIND && preset.kind !== "local" && preset.apiKeyRequired,
  );
  const local = api.presets.filter((preset) => preset.kind === "local");
  const orbital = api.presets.find((preset) => preset.kind === ORBITAL_KIND) ?? null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Escape and the close button are the same answer as "Later": this machine has been asked.
        if (!next) onDismiss();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose a model provider</DialogTitle>
          <DialogDescription>
            Orbital plans, builds, tests and syncs with one model endpoint of your choosing. Your
            account decides who you are; this decides which model runs. It can be changed any time
            from the composer, or from Settings.
          </DialogDescription>
        </DialogHeader>

        {api.status === "loading" && api.presets.length === 0 ? (
          <p className="py-6 text-center text-2xs text-muted-foreground">Loading providers…</p>
        ) : api.status === "error" && api.presets.length === 0 ? (
          <div className="flex flex-col items-start gap-2 py-2">
            <span className="text-2xs leading-relaxed text-phase-test">{api.error}</span>
            <Button size="xs" variant="secondary" onClick={() => void api.refresh()}>
              Retry
            </Button>
          </div>
        ) : (
          <Tabs value={way} onValueChange={(next) => setWay(next as typeof way)}>
            <TabsList className="w-full">
              <TabsTrigger value="provider">Provider and key</TabsTrigger>
              <TabsTrigger value="orbital">Orbital</TabsTrigger>
              <TabsTrigger value="local">Local</TabsTrigger>
            </TabsList>

            <TabsContent value="provider">
              <EndpointSetup api={api} presets={keyed} onDone={onDismiss} />
            </TabsContent>

            <TabsContent value="local">
              <div className="flex flex-col gap-2">
                <p className={LABEL}>
                  A model on this machine — no key, and nothing leaves it. Ollama listens on 11434
                  and LM Studio on 1234; whichever is not running will say so when you connect.
                </p>
                <EndpointSetup api={api} presets={local} onDone={onDismiss} />
              </div>
            </TabsContent>

            <TabsContent value="orbital">
              {orbital === null ? (
                <p className={LABEL}>This runtime does not offer an Orbital provider.</p>
              ) : (
                <OrbitalSetup api={api} preset={orbital} onDone={onDismiss} />
              )}
            </TabsContent>
          </Tabs>
        )}

        <DialogFooter className="justify-between">
          <span className="flex items-start gap-1.5 pr-4 text-left">
            <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-primary" aria-hidden />
            <span className={LABEL}>
              A pasted key is stored on this machine and sent only to that provider&rsquo;s own
              endpoint.
            </span>
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="secondary" onClick={onDismiss}>
              Later
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
