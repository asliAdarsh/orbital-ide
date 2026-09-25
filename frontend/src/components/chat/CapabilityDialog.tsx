import { useEffect, useState } from "react";
import { RotateCcw, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { COMPOSER_MODES, useAppStore } from "@/store/app-store";
import type { CapabilityId, CapabilityInfo } from "@/types/protocol";

interface CapabilityGroupProps {
  heading: string;
  hint: string;
  items: CapabilityInfo[];
  enabled: Record<CapabilityId, boolean>;
  onToggle(id: CapabilityId, on: boolean): void;
}

/** One bucket of the catalogue: the capabilities the mode starts with, or the ones it leaves off. */
function CapabilityGroup({ heading, hint, items, enabled, onToggle }: CapabilityGroupProps) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
      </h3>
      <p className="text-2xs text-muted-foreground">{hint}</p>
      <div className="mt-0.5 flex flex-col gap-1">
        {items.map((info) => (
          <label
            key={info.id}
            className="flex cursor-pointer items-start gap-2 rounded border border-border p-2 transition-colors hover:bg-chrome-raised"
          >
            <input
              type="checkbox"
              checked={enabled[info.id]}
              onChange={(event) => onToggle(info.id, event.target.checked)}
              className="mt-0.5 size-3 shrink-0 accent-primary"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs text-foreground">{info.label}</span>
              <span className="text-2xs text-muted-foreground">{info.description}</span>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

/**
 * The composer's config dialog: what the agent may do, and the approval setting it runs under.
 *
 * The list, its wording and its defaults all come from `GET /api/capabilities`, so this renders
 * whatever the runtime publishes rather than carrying a copy that would drift. The groups are the
 * mode's own defaults — on versus off — which is what makes a mode's shape legible at a glance,
 * while each checkbox still shows the setting in force.
 */
export function CapabilityDialog() {
  const [open, setOpen] = useState(false);
  const mode = useAppStore((s) => s.composerMode);
  const catalogue = useAppStore((s) => s.capabilityCatalogue);
  const loading = useAppStore((s) => s.capabilitiesLoading);
  const error = useAppStore((s) => s.capabilitiesError);
  const capabilities = useAppStore((s) => s.capabilities);
  const loadCapabilities = useAppStore((s) => s.loadCapabilities);
  const setCapability = useAppStore((s) => s.setCapability);
  const resetCapabilityDefaults = useAppStore((s) => s.resetCapabilityDefaults);

  // The catalogue is one request per session, cached in the store, so mounting the composer is
  // what fetches it — a run's frame needs the defaults whether or not this dialog is ever opened.
  useEffect(() => {
    loadCapabilities();
  }, [loadCapabilities]);

  const modeLabel = COMPOSER_MODES.find((entry) => entry.id === mode)?.label ?? mode;
  // The mode's own defaults, computed once: the groups are built from this, and the ternary is
  // what reads the right column of the catalogue.
  const startsOn = new Set(
    catalogue
      .filter((info) => (mode === "plan" ? info.planDefault : info.buildDefault))
      .map((info) => info.id),
  );
  const included = catalogue.filter((info) => startsOn.has(info.id));
  const excluded = catalogue.filter((info) => !startsOn.has(info.id));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="icon"
          variant="outline"
          className="size-6 shrink-0"
          aria-label="Configure the agent"
          title="Configure what the agent may do"
        >
          <Settings2 className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[88vh] w-[min(34rem,92vw)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configure the agent</DialogTitle>
          <DialogDescription>
            What the agent may do while you are in {modeLabel}. These options follow the mode, so
            switching to the other one applies its own set — and anything you change here is kept
            for {modeLabel}.
          </DialogDescription>
        </DialogHeader>
        {error !== null ? (
          <p className="text-destructive">
            Could not load what the agent may do: {error}. The agent keeps its full toolset until
            this loads.
          </p>
        ) : catalogue.length === 0 ? (
          <p className="text-muted-foreground">
            {loading ? "Loading what the agent may do…" : "The runtime has published no capabilities."}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <CapabilityGroup
              heading={`On in ${modeLabel} by default`}
              hint={`What ${modeLabel} starts with.`}
              items={included}
              enabled={capabilities}
              onToggle={setCapability}
            />
            {excluded.length > 0 ? (
              <CapabilityGroup
                heading={`Off in ${modeLabel} by default`}
                hint={`What ${modeLabel} leaves out unless you turn it on.`}
                items={excluded}
                enabled={capabilities}
                onToggle={setCapability}
              />
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            disabled={catalogue.length === 0}
            onClick={() => resetCapabilityDefaults(mode)}
            title={`Restore what ${modeLabel} starts with, discarding your changes in ${modeLabel}`}
          >
            <RotateCcw className="size-3.5" />
            Reset to this mode's defaults
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
