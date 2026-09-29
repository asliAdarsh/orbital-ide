/**
 * The provider profiles, for the settings dialog.
 *
 * Every row is one endpoint a run may talk to, with the credential reduced to whether there is one
 * and how it ends — the key itself is never in a response, so it can never be in a row. A test
 * result belongs beside the row it was run for: the same key is accepted by one endpoint and
 * refused by another, and a single verdict for the whole page would be a claim about the wrong
 * endpoint.
 *
 * The list redraws from whatever the API returns for a mutation. Deleting the active profile hands
 * the badge to another one in the same response, so nothing here guesses which that will be.
 */

import { useState } from "react";

import { useProviders } from "@/hooks/useProviders";
import {
  endpointHost,
  kindNeedsKey,
  ORBITAL_KIND,
  orbitalDraft,
  type ProviderPatch,
  type ProviderPreset,
  type ProviderProfile,
} from "@/lib/providers";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmButton } from "@/components/common/ConfirmButton";
import { SectionLabel } from "@/components/common/SectionLabel";
import { StatusDot } from "@/components/common/StatusDot";

const LABEL = "text-2xs text-muted-foreground";
const FIELD = "h-7 font-mono text-2xs";

/** The editable slice of a profile, as typed into the row: every field present. */
interface Draft {
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function ProvidersPanel() {
  const {
    status,
    profiles,
    presets,
    activeId,
    error,
    notice,
    busy,
    refresh,
    create,
    update,
    remove,
    activate,
    connect,
    test,
  } = useProviders();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ label: "", baseUrl: "", model: "", apiKey: "" });
  // What the endpoint last said, from whichever call asked. A test and a connect answer in the same
  // two fields, and a row shows whichever verdict was most recent — a connect that succeeded
  // supersedes an older test, and the reverse.
  const [results, setResults] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  // The gateway's words when setting Orbital up from here could not read its catalogue.
  const [setupDetail, setSetupDetail] = useState<string | null>(null);

  const active = profiles.find((profile) => profile.id === activeId) ?? null;
  // The one state a profile can be in that stops every run: a keyed provider with no key. The
  // backend refuses to substitute the dotenv key for it, so this is worth saying plainly. An
  // `orbital` profile is never in it — its key is the account's token, which the app keeps current,
  // and a cleared one is the gateway's own 401 to give.
  const blocked = active !== null && kindNeedsKey(active.kind) && !active.apiKeySet;
  /** The Orbital preset, offered here only while no profile of that kind exists. */
  const orbitalPreset =
    profiles.some((profile) => profile.kind === ORBITAL_KIND)
      ? null
      : (presets.find((preset: ProviderPreset) => preset.kind === ORBITAL_KIND) ?? null);

  const startEdit = (profile: ProviderProfile) => {
    setEditingId(profile.id);
    // Blank means "leave the stored key alone"; clearing it is its own action.
    setDraft({ label: profile.label, baseUrl: profile.baseUrl, model: profile.model, apiKey: "" });
  };

  /** Forget a row's verdict: it described the profile as it was, not as it is now. */
  const forgetResult = (id: string) =>
    setResults((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });

  const saveEdit = async (profile: ProviderProfile) => {
    const patch: ProviderPatch = {};
    if (draft.label !== profile.label) patch.label = draft.label;
    if (draft.baseUrl !== profile.baseUrl) patch.baseUrl = draft.baseUrl;
    if (draft.model !== profile.model) patch.model = draft.model;
    if (draft.apiKey !== "") patch.apiKey = draft.apiKey;
    // A row opened and closed without a change is not an edit, and sending one would rewrite the
    // store for nothing.
    if (Object.keys(patch).length === 0) {
      setEditingId(null);
      return;
    }
    if (!(await update(profile.id, patch))) return;
    forgetResult(profile.id);
    setEditingId(null);
  };

  const clearKey = async (id: string) => {
    if (await update(id, { apiKey: "" })) forgetResult(id);
  };

  const runTest = async (id: string) => {
    setTestingId(id);
    const result = await test(id);
    setTestingId(null);
    // A null means the call never landed, which the panel's own error line reports; there is no
    // endpoint answer to show beside the row.
    if (result === null) return;
    setResults((current) => ({ ...current, [id]: result }));
  };

  /**
   * Ask the endpoint what it serves and store the answer.
   *
   * This is the same step the setup dialog runs, offered here because it is the only way to obtain
   * a model list for a profile that was configured without one — a key the runtime migrated in, or
   * an endpoint that was down the first time. Its verdict lands beside the row like a test's: a
   * refused key is an answer, and a list that came from the preset says so.
   */
  const runConnect = async (id: string) => {
    setTestingId(id);
    const result = await connect(id);
    setTestingId(null);
    if (result === null) return;
    setResults((current) => ({ ...current, [id]: result }));
  };

  const drop = async (id: string) => {
    forgetResult(id);
    if (editingId === id) setEditingId(null);
    await remove(id);
  };

  /**
   * Set Orbital up from settings.
   *
   * Onboarding is where this usually happens, but it is shown once: someone who chose "Later" comes
   * back through here. Nothing is typed — the URL is built from this build's Firebase project, the
   * model is the first one the gateway's own catalogue names, and the account's token is the key —
   * so the whole profile is one press. A catalogue that does not answer still creates it, with the
   * preset's default model, and the gateway's words are shown beside the button.
   */
  const addOrbital = async () => {
    if (orbitalPreset === null) return;
    setSetupDetail(null);
    const { draft, catalogueDetail } = await orbitalDraft(orbitalPreset);
    setSetupDetail(catalogueDetail);
    if (draft === null) return;
    const added = await create(draft);
    if (added === null) return;
    if (!(await activate(added.id))) return;
    const result = await test(added.id);
    if (result !== null) setResults((current) => ({ ...current, [added.id]: result }));
  };

  return (
    <div className="flex flex-col gap-2">
      <SectionLabel className="-mx-2">Model providers</SectionLabel>

      {profiles.length > 0 ? (
        <p className="flex items-center gap-1.5 text-2xs leading-relaxed text-muted-foreground">
          <StatusDot state={active !== null && !blocked ? "online" : "offline"} />
          {active === null
            ? "No active profile — activate one below."
            : blocked
              ? `${active.label} has no key, so runs cannot start.`
              : `Runs use ${active.label} · ${active.model} at ${endpointHost(active.baseUrl)}.`}
        </p>
      ) : null}

      {notice !== null ? (
        <p className="text-2xs leading-relaxed text-phase-test">{notice}</p>
      ) : null}

      {orbitalPreset !== null ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" variant="secondary" disabled={busy} onClick={() => void addOrbital()}>
              Use Orbital
            </Button>
            <span className="text-2xs leading-relaxed text-muted-foreground">
              Runs use Orbital&rsquo;s key through your account — nothing to paste, and the key never
              reaches this machine.
            </span>
          </div>
          {setupDetail !== null ? (
            <span className="font-mono text-2xs leading-relaxed text-phase-test">
              {setupDetail}
            </span>
          ) : null}
        </div>
      ) : null}

      {error !== null ? (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-2xs leading-relaxed text-phase-test">{error}</span>
          {status === "error" ? (
            <Button size="xs" variant="secondary" onClick={() => void refresh()}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      {status === "loading" && profiles.length === 0 ? (
        <p className="py-4 text-center text-2xs text-muted-foreground">Loading providers…</p>
      ) : profiles.length === 0 ? (
        <p className="text-2xs leading-relaxed text-muted-foreground">
          No provider profile, so runs cannot start. Orbital asks for one the next time it starts.
        </p>
      ) : (
        <div className="flex flex-col">
          {profiles.map((profile) => {
            const isActive = profile.id === activeId;
            const result = results[profile.id];
            const editing = editingId === profile.id;
            // Only the tail the API hands out is ever shown: four characters identify a key in a
            // list, and the key itself never leaves the backend. An Orbital profile has no key of
            // the user's at all — what it holds is the account's token, which is worth naming.
            const key =
              profile.kind === ORBITAL_KIND
                ? profile.apiKeySet
                  ? "account token"
                  : "no account token"
                : profile.apiKeyHint !== null
                  ? `key …${profile.apiKeyHint}`
                  : profile.apiKeySet
                    ? "key set"
                    : "no key";

            return (
              <div
                key={profile.id}
                className="flex flex-col gap-2 border-b border-border py-2.5 last:border-b-0"
              >
                <div className="flex items-start gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs text-foreground">{profile.label}</span>
                      <Badge variant="outline">{profile.kind}</Badge>
                      {isActive ? <Badge variant="success">active</Badge> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-2xs text-muted-foreground">
                      <span className="truncate">{profile.model}</span>
                      <span className="truncate">{endpointHost(profile.baseUrl)}</span>
                      <span>{key}</span>
                      {/* Which list the model above was chosen from, and whether it is the
                          provider's own answer or the preset's curation. */}
                      <span className="truncate">
                        {profile.modelsSource === null
                          ? "no model list yet"
                          : `${profile.models.length} models from the ${
                              profile.modelsSource === "provider" ? "provider" : "preset"
                            }`}
                      </span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {isActive ? null : (
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void activate(profile.id)}
                      >
                        Activate
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => (editing ? setEditingId(null) : startEdit(profile))}
                    >
                      {editing ? "Cancel" : "Edit"}
                    </Button>
                    <Button
                      size="xs"
                      variant="secondary"
                      loading={testingId === profile.id}
                      disabled={busy}
                      onClick={() => void runConnect(profile.id)}
                    >
                      Connect
                    </Button>
                    <Button
                      size="xs"
                      variant="secondary"
                      loading={testingId === profile.id}
                      disabled={busy}
                      onClick={() => void runTest(profile.id)}
                    >
                      Test
                    </Button>
                    <ConfirmButton
                      confirmLabel="Confirm delete"
                      disabled={busy}
                      onConfirm={() => void drop(profile.id)}
                    >
                      Delete
                    </ConfirmButton>
                  </div>
                </div>

                {result !== undefined ? (
                  <span
                    className={cn(
                      "text-2xs leading-relaxed",
                      result.ok ? "text-muted-foreground" : "text-phase-test",
                    )}
                  >
                    {result.ok ? `Reachable — ${result.detail}` : result.detail}
                  </span>
                ) : null}

                {editing ? (
                  <div className="flex flex-col gap-2 rounded border border-border bg-chrome-sunken p-2">
                    <div className="grid grid-cols-[6rem_1fr] items-center gap-2">
                      <span className={LABEL}>Label</span>
                      <Input
                        className={FIELD}
                        value={draft.label}
                        disabled={busy}
                        onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                      />
                      <span className={LABEL}>Base URL</span>
                      <Input
                        className={FIELD}
                        value={draft.baseUrl}
                        disabled={busy}
                        onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                      />
                      <span className={LABEL}>Model</span>
                      <Input
                        className={FIELD}
                        value={draft.model}
                        disabled={busy}
                        onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                      />
                      {profile.kind === ORBITAL_KIND ? (
                        // No field, and no "Clear key" either: this profile's key is the account's
                        // token, which the app writes and refreshes itself. Offering to edit it
                        // would invite someone to paste a credential this kind never uses.
                        <>
                          <span className={LABEL}>Account</span>
                          <span className="text-2xs leading-relaxed text-muted-foreground">
                            Runs use Orbital&rsquo;s key through your account. The stored token
                            refreshes on its own.
                          </span>
                        </>
                      ) : (
                        <>
                          <span className={LABEL}>API key</span>
                          <div className="flex items-center gap-1.5">
                            <Input
                              type="password"
                              autoComplete="off"
                              className={FIELD}
                              placeholder={
                                profile.apiKeySet
                                  ? "leave blank to keep the stored key"
                                  : "no key stored"
                              }
                              value={draft.apiKey}
                              disabled={busy}
                              onChange={(event) =>
                                setDraft({ ...draft, apiKey: event.target.value })
                              }
                            />
                            {profile.apiKeySet ? (
                              <ConfirmButton
                                confirmLabel="Confirm clear"
                                disabled={busy}
                                onConfirm={() => void clearKey(profile.id)}
                              >
                                Clear key
                              </ConfirmButton>
                            ) : null}
                          </div>
                        </>
                      )}
                    </div>
                    <div>
                      <Button size="xs" loading={busy} onClick={() => void saveEdit(profile)}>
                        Save
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
