/**
 * The composer's provider and model control: one button, one popover, both choices inline.
 *
 * The endpoint a message runs against is two decisions that only make sense together — which
 * provider, and which of its models — so they live in one control rather than two that could be
 * read independently. The button states the pair that will actually run, because that is the thing
 * the user needs to be sure of before pressing send.
 *
 * Choosing here pins the *run*, not the account: the frame carries `providerId` and `model`, the
 * runtime resolves that profile for that message alone, and the active profile in settings does not
 * move. That is deliberate — the composer is where a single message is decided, and silently
 * re-pointing every other session from here would make the settings badge a lie.
 *
 * The model list is read from the runtime when the popover opens, per profile. It is stored state
 * (`GET /api/providers/{id}/models` makes no network call of its own), so opening the list can never
 * wait on a provider, and a reconnect done in the setup dialog shows up here without a reload. The
 * copy already on the profile draws the list while that read is in flight.
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cpu } from "lucide-react";

import { endpointHost, isEmbeddingModel, providers, type ProviderModelsResult } from "@/lib/providers";
import { errorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useProviders } from "@/hooks/useProviders";
import { useAppStore } from "@/store/app-store";

/**
 * Past this many models the popover grows a filter box; below it a filter would be a control the
 * list is shorter than.
 */
const FILTER_THRESHOLD = 8;

export interface ProviderModelPickerProps {
  /**
   * Controlled open state. The composer's `/model` command opens this picker from the outside, and
   * a trigger that owned the state alone could not be opened by anything but a click.
   */
  open?: boolean;
  onOpenChange?(open: boolean): void;
}

export function ProviderModelPicker({ open: controlledOpen, onOpenChange }: ProviderModelPickerProps = {}) {
  const providerId = useAppStore((store) => store.providerId);
  const model = useAppStore((store) => store.model);
  const setProviderId = useAppStore((store) => store.setProviderId);
  const setModel = useAppStore((store) => store.setModel);
  const pushLog = useAppStore((store) => store.pushLog);
  const { status, profiles, activeId, refresh } = useProviders();

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const [query, setQuery] = useState("");
  // The list is held with the profile it was read for, so a slow answer cannot be drawn under a
  // profile the user has since switched to.
  const [listed, setListed] = useState<({ profileId: string } & ProviderModelsResult) | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // The pin decides, and the active profile is the fallback: a user who has never switched is on
  // whatever settings activated, which is what the badge over there claims too.
  const pinned = profiles.find((profile) => profile.id === providerId) ?? null;
  const effective = pinned ?? profiles.find((profile) => profile.id === activeId) ?? null;
  const effectiveId = effective?.id ?? null;

  useEffect(() => {
    if (!open) return;
    // Read the list fresh on every open: the setup dialog and the settings page both change which
    // profile is active and what it serves, and a picker holding the list it mounted with would
    // mark the wrong row as active. This is the same rule the account popover follows.
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    // A profile deleted in settings must not keep a run pointed at it: the frame would carry an id
    // the runtime refuses, and every send would fail on a choice the user has already undone. Only
    // a settled read may clear it — an empty list before the first answer would wipe a valid pin.
    if (status !== "ready" || providerId === "") return;
    if (profiles.some((profile) => profile.id === providerId)) return;
    setProviderId("");
  }, [status, profiles, providerId, setProviderId]);

  useEffect(() => {
    if (!open || effectiveId === null) return;
    let live = true;
    providers.models(effectiveId).then(
      (result) => {
        if (live) setListed({ ...result, profileId: effectiveId });
      },
      (error: unknown) => {
        pushLog("warn", `Could not read the stored model list: ${errorMessage(error)}`);
      },
    );
    return () => {
      live = false;
    };
  }, [open, effectiveId, pushLog]);

  const read = listed?.profileId === effectiveId ? listed : null;
  const stored = read?.models ?? effective?.models ?? [];
  // Embedding ids are filtered from what is offered — see `isEmbeddingModel` — and the filter box
  // below is what lets a model be named by hand regardless.
  const offered = stored.filter((id) => !isEmbeddingModel(id));
  const needle = query.trim().toLowerCase();
  const showFilter = offered.length > FILTER_THRESHOLD;
  const visible = needle === "" ? offered : offered.filter((id) => id.toLowerCase().includes(needle));
  // A typed id that matches nothing is still a model the user may mean: LM Studio and Ollama both
  // serve ids nothing here has heard of until they are running.
  const typed = query.trim() !== "" && !visible.some((id) => id === query.trim());

  const effectiveModel = model || effective?.model || "";
  const caption =
    effective === null ? "No provider" : `${effective.label} · ${effectiveModel || "no model"}`;

  const pin = (id: string) => {
    if (id === providerId) return;
    // The old model id names nothing at the new endpoint — model ids are not portable between
    // providers — so the pin starts from the new profile's own model, which is a real answer.
    setProviderId(id);
    setModel("");
  };

  const chooseModel = (id: string) => {
    setModel(id);
    setOpen(false);
  };

  const renderModelRow = (id: string, label: string, selected: boolean) => (
    <button
      key={id}
      type="button"
      role="radio"
      aria-checked={selected}
      title={label}
      onClick={() => chooseModel(id)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-chrome-raised",
        selected ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Check className={cn("size-3 shrink-0", selected ? "opacity-100" : "opacity-0")} />
      <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
    </button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // A filter left over from the last open would hide the list it is meant to narrow.
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant="outline"
          aria-label="Provider and model"
          className="max-w-52 shrink-0 gap-1 font-mono"
          title={`Runs use ${caption}`}
        >
          <Cpu className="size-3 shrink-0" />
          <span className="truncate">{caption}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-0"
        onOpenAutoFocus={(event) => {
          // The filter box is the reason to type here; without one, Radix's default focus on the
          // panel is what lets the arrow keys scroll the lists.
          if (!showFilter) return;
          event.preventDefault();
          filterRef.current?.focus();
        }}
      >
        {status === "loading" && profiles.length === 0 ? (
          <p className="p-2 text-muted-foreground">Loading providers…</p>
        ) : profiles.length === 0 ? (
          <p className="p-2 leading-relaxed text-muted-foreground">
            No provider profile yet, so runs cannot start. Configure one in Settings, under Model
            providers.
          </p>
        ) : (
          <>
            <div className="border-b border-border p-1">
              <div className="px-1 pb-1 text-2xs text-muted-foreground">Provider</div>
              <div role="radiogroup" aria-label="Provider" className="max-h-32 overflow-y-auto">
                {profiles.map((profile) => {
                  // The pin is shown as what it is: the active profile is a note on the row, not
                  // the selection, so "which runs use this" is readable at a glance.
                  const selected = profile.id === effectiveId;
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      title={`${profile.label} at ${profile.baseUrl}`}
                      onClick={() => pin(profile.id)}
                      className={cn(
                        "flex w-full items-start gap-1.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-chrome-raised",
                        selected ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <Check className={cn("mt-0.5 size-3 shrink-0", selected ? "opacity-100" : "opacity-0")} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{profile.label}</span>
                        <span className="truncate font-mono text-2xs text-muted-foreground">
                          {endpointHost(profile.baseUrl)}
                        </span>
                      </span>
                      {profile.id === activeId ? (
                        <span className="shrink-0 rounded border border-border px-1 text-2xs text-muted-foreground">
                          active
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="p-1">
              <div className="px-1 pb-1 text-2xs text-muted-foreground">
                Model {effective === null ? "" : `— ${effective.label}`}
              </div>
              {showFilter ? (
                <div className="px-1 pb-1">
                  <Input
                    ref={filterRef}
                    value={query}
                    aria-label="Filter or type a model"
                    placeholder="Filter, or type a model id"
                    onChange={(event) => setQuery(event.target.value)}
                    className="h-6 text-2xs"
                  />
                </div>
              ) : null}
              <div role="radiogroup" aria-label="Model" className="max-h-48 overflow-y-auto">
                {effective !== null
                  ? renderModelRow("", effective.model || "provider default", model === "")
                  : null}
                {visible.map((id) => renderModelRow(id, id, model === id))}
                {typed ? renderModelRow(query.trim(), `Use “${query.trim()}”`, false) : null}
              </div>
              {effective !== null && offered.length === 0 ? (
                <p className="px-1 py-1 leading-relaxed text-muted-foreground">
                  {/* An empty list has two causes and they are not the same problem: nothing has
                      been connected yet, or everything the endpoint listed was an embedding id. */}
                  {(read?.source ?? effective.modelsSource) === null
                    ? `${effective.label} has not been connected yet, so it has no stored list — connect it in Settings, or type an id above.`
                    : `${effective.label} listed only embedding ids. Type a chat model id above.`}
                </p>
              ) : null}
              {effective === null ? (
                <p className="px-1 py-1 leading-relaxed text-muted-foreground">
                  The pinned provider is no longer configured. Pick one above.
                </p>
              ) : null}
            </div>

            <p className="border-t border-border px-2 py-1 text-muted-foreground">
              {effective === null
                ? "No endpoint to run against."
                : `Messages run on ${effective.label} at ${endpointHost(effective.baseUrl)}.`}
              {effective !== null && read !== null && read.source !== null ? (
                <>
                  {" "}
                  {/* Where the list came from, because a curated one is not a claim about what this
                      key reaches. */}
                  {read.source === "provider" ? "List from the provider" : "List from the preset"}
                  {read.fetchedAt !== null
                    ? `, stored ${new Date(read.fetchedAt * 1000).toLocaleString()}`
                    : ""}
                  .
                </>
              ) : null}
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
