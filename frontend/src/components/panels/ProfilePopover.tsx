/**
 * The account row and the provider the runtime runs on.
 *
 * Two unrelated things share one popover because to the person using it they answer the same
 * question — "who am I, in here": the Orbital account the app is gated on, and the model provider
 * the runtime holds. The provider is only *read* here, and changed in settings: a second place to
 * paste a key is a second place to paste the wrong one.
 *
 * ``label`` turns the trigger into a labelled row, for the places that present it in a list of
 * buttons rather than in a strip of icons.
 */

import { useEffect, useState } from "react";
import { CircleUser } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { useProviders } from "@/hooks/useProviders";
import { endpointHost } from "@/lib/providers";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusDot } from "@/components/common/StatusDot";

export function ProfilePopover({ label }: { label?: string } = {}) {
  const { user, signOut: endAccountSession, busy: endingAccountSession } = useAuth();
  const { status, profiles, activeId, error, refresh } = useProviders();
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const [open, setOpen] = useState(false);

  // Read the provider fresh on every open: it changes in the settings dialog and in the first-run
  // screen, and this popover is the only place the account is looked at.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const active = profiles.find((profile) => profile.id === activeId) ?? null;
  // A keyed provider with no key is the one state that stops every run, and it is not visible in
  // the label or the endpoint, so the dot says it here.
  const blocked = active !== null && active.kind !== "local" && !active.apiKeySet;

  // Closing first: settings opens over the workspace, and a popover left open behind it would
  // reappear on top of the dialog the user is reading.
  const changeProvider = () => {
    setOpen(false);
    setSettingsOpen(true);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {label ? (
          <button
            type="button"
            aria-label={label}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-2xs text-muted-foreground transition-colors hover:bg-chrome-raised hover:text-foreground"
          >
            <CircleUser className="h-3.5 w-3.5" />
            {label}
          </button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            aria-label="Account and model provider"
          >
            <CircleUser className="h-4 w-4" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="flex w-64 flex-col gap-2 text-2xs">
        {user === null ? null : (
          // First, because it is the thing the app is gated on: the provider below belongs to the
          // runtime, and reading it as the account would be a lie.
          <div className="flex flex-col gap-1.5 border-b border-border pb-2">
            <span className="text-2xs text-muted-foreground">Orbital account</span>
            <span className="truncate font-mono text-2xs text-foreground">{user.email ?? user.uid}</span>
            <Button
              size="xs"
              variant="secondary"
              className="w-full"
              loading={endingAccountSession}
              onClick={() => void endAccountSession()}
            >
              Sign out
            </Button>
          </div>
        )}

        {status === "loading" ? (
          <p className="text-2xs text-muted-foreground">Checking the provider…</p>
        ) : status === "error" ? (
          <p className="font-mono text-2xs leading-relaxed text-phase-test">{error}</p>
        ) : active === null ? (
          <>
            <div className="flex items-center gap-1.5">
              <StatusDot state="offline" />
              <span className="text-2xs text-phase-test">No provider configured</span>
            </div>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              Agent runs need a model provider. This is the endpoint the runtime holds, not your Orbital
              account.
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <StatusDot state={blocked ? "offline" : "online"} />
              <span className={blocked ? "text-2xs text-phase-test" : "text-2xs text-foreground"}>
                {blocked ? "No key on the active provider" : "Provider configured"}
              </span>
            </div>
            <div className="flex flex-col gap-0.5 font-mono text-2xs text-muted-foreground">
              <span className="truncate">{active.label}</span>
              <span className="truncate">{endpointHost(active.baseUrl)}</span>
              <span className="truncate">{active.model || "provider default"}</span>
            </div>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              The model provider the Orbital runtime uses, separate from your Orbital account.
            </p>
          </>
        )}

        <Button size="xs" variant="secondary" className="w-full" onClick={changeProvider}>
          Change provider
        </Button>
      </PopoverContent>
    </Popover>
  );
}
