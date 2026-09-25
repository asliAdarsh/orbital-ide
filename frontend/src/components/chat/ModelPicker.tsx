import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cpu } from "lucide-react";

import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";
import type { ModelsResponse } from "@/types/protocol";

/**
 * Past this many models the popover grows a search box; below it a filter would be a control the
 * list is shorter than.
 */
const SEARCH_THRESHOLD = 8;

/**
 * The picker unmounts whenever the sidebar leaves the Agent tab, so the request is memoised at
 * module scope: the gateway's catalogue is fetched once per app session, not once per mount.
 * A failed request clears the memo so the next mount retries.
 */
let modelsRequest: Promise<ModelsResponse> | null = null;

function loadModels(): Promise<ModelsResponse> {
  modelsRequest ??= api.models().catch((error: unknown) => {
    modelsRequest = null;
    throw error;
  });
  return modelsRequest;
}

/**
 * The model control for the composer toolbar.
 *
 * A button, not a native `<select>`: the sidebar is ~340px wide and the model ids are long, so the
 * select was truncating the one thing the control exists to say. The button always shows the model
 * that will actually run — the backend's default id until the user picks another — and the popover
 * holds the list, with the default and the current choice marked.
 */
export function ModelPicker() {
  const model = useAppStore((s) => s.model);
  const models = useAppStore((s) => s.models);
  // Health carries the configured model from boot, so the button has a real name to show in the
  // window before the catalogue request lands.
  const healthModel = useAppStore((s) => s.health?.model ?? "");
  const setModel = useAppStore((s) => s.setModel);
  const setModels = useAppStore((s) => s.setModels);
  const pushLog = useAppStore((s) => s.pushLog);
  const [backendDefault, setBackendDefault] = useState("");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadModels().then(
      (response) => {
        setModels(response.models);
        setBackendDefault(response.default);
      },
      (error: unknown) => {
        pushLog(
          "warn",
          `Could not load models: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  }, [setModels, pushLog]);

  // Only opencode is promoted; the gateway's own order carries meaning within the rest.
  const ordered = [
    ...models.filter((info) => info.ownedBy === "opencode"),
    ...models.filter((info) => info.ownedBy !== "opencode"),
  ];
  // A persisted id can outlive the gateway's catalogue; keep it selectable instead of blanking.
  const staleSelection = model !== "" && !ordered.some((info) => info.id === model);
  const fallback = backendDefault || healthModel;
  const effective = model || fallback;
  const needle = query.trim().toLowerCase();
  const showSearch = ordered.length > SEARCH_THRESHOLD;
  const visible =
    needle === "" ? ordered : ordered.filter((info) => info.id.toLowerCase().includes(needle));

  const choose = (id: string) => {
    setModel(id);
    setOpen(false);
  };

  const renderRow = (id: string, label: string, selected: boolean, isDefault: boolean) => (
    <button
      key={id}
      type="button"
      role="radio"
      aria-checked={selected}
      title={label}
      onClick={() => choose(id)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-chrome-raised",
        selected ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Check className={cn("size-3 shrink-0", selected ? "opacity-100" : "opacity-0")} />
      <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
      {isDefault ? (
        <span className="shrink-0 rounded border border-border px-1 text-muted-foreground">
          default
        </span>
      ) : null}
    </button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // A fresh query each time: a filter left over from the last open would hide the list.
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant="outline"
          aria-label="Model"
          className="max-w-44 shrink-0 gap-1 font-mono"
          title={model === "" ? `Model: ${effective} (backend default)` : `Model: ${effective}`}
        >
          <Cpu className="size-3 shrink-0" />
          <span className="truncate">{effective || "…"}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-0"
        onOpenAutoFocus={(event) => {
          // The search box is the reason to type here; without one, Radix's default focus on the
          // panel is what lets the arrow keys scroll the list.
          if (!showSearch) return;
          event.preventDefault();
          searchRef.current?.focus();
        }}
      >
        {ordered.length === 0 && !staleSelection ? (
          <p className="p-2 text-muted-foreground">
            {fallback
              ? `No model list from the gateway; runs use ${fallback}.`
              : "Loading the gateway's models…"}
          </p>
        ) : (
          <>
            {showSearch ? (
              <div className="border-b border-border p-1">
                <Input
                  ref={searchRef}
                  value={query}
                  aria-label="Search models"
                  placeholder="Search models"
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-6 text-2xs"
                />
              </div>
            ) : null}
            <div role="radiogroup" aria-label="Model" className="max-h-56 overflow-y-auto p-1">
              {renderRow("", fallback || "Backend default", model === "", true)}
              {visible.map((info) => renderRow(info.id, info.id, model === info.id, info.id === fallback))}
              {staleSelection ? renderRow(model, model, true, false) : null}
            </div>
            {visible.length === 0 ? (
              <p className="px-2 py-1 text-muted-foreground">No model matches “{query.trim()}”.</p>
            ) : null}
            <p className="border-t border-border px-2 py-1 text-muted-foreground">
              In use: {effective || "the backend default"}
              {model === "" ? " (backend default)" : ""}
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
