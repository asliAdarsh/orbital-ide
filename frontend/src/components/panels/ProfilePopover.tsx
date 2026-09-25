import { useEffect, useState } from "react";
import { CircleUser } from "lucide-react";

import { api, errorMessage } from "@/lib/api";
import type { ConfigResponse } from "@/types/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ConfirmButton } from "@/components/common/ConfirmButton";
import { StatusDot } from "@/components/common/StatusDot";
import { toast } from "@/components/common/Toaster";

/** Host and port of the configured endpoint, or the raw value when it is not a URL. */
function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * The model-provider credential, not an app account: Orbital stores exactly one API key
 * for the configured gateway, and this control is where it is set, checked and cleared.
 */
/**
 * ``label`` turns the trigger into a labelled row, for the places that present it in a list of
 * buttons rather than in a strip of icons.
 */
export function ProfilePopover({ label }: { label?: string } = {}) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Read the credential state fresh on every open: it can change from the settings page
  // or a backend restart, and the key itself is never fetched.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setApiKey("");
    void api
      .config()
      .then((next) => {
        if (!cancelled) setConfig(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) toast.error(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSignIn = async () => {
    const key = apiKey.trim();
    if (key === "") return;
    setSubmitting(true);
    try {
      await api.updateConfig({ apiKey: key });
      setConfig(await api.config());
      setApiKey("");
      toast.success("Provider key stored.");
    } catch (err: unknown) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    setSubmitting(true);
    try {
      await api.updateConfig({ apiKey: "" });
      setConfig(await api.config());
      toast.success("Signed out — the stored provider key was cleared.");
    } catch (err: unknown) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const signedIn = config?.apiKeyConfigured ?? false;

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
            aria-label="Model provider credential"
          >
            <CircleUser className="h-4 w-4" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="flex w-64 flex-col gap-2 text-2xs">
        {loading ? (
          <p className="text-2xs text-muted-foreground">Checking credentials…</p>
        ) : config === null ? (
          <p className="text-2xs text-phase-test">
            Could not read the credential state from the backend. Close and reopen to retry.
          </p>
        ) : signedIn ? (
          <>
            <div className="flex items-center gap-1.5">
              <StatusDot state="online" />
              <span className="text-2xs text-foreground">Provider key stored</span>
            </div>
            <div className="flex flex-col gap-0.5 font-mono text-2xs text-muted-foreground">
              <span className="truncate">{endpointHost(config.baseUrl)}</span>
              <span className="truncate">{config.model || "gateway default"}</span>
            </div>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              The model-provider credential held by the Orbital runtime — there is no Orbital app account.
            </p>
            <ConfirmButton
              className="w-full"
              confirmLabel="Confirm sign out"
              disabled={submitting}
              onConfirm={() => void handleSignOut()}
            >
              Sign out
            </ConfirmButton>
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <StatusDot state="offline" />
              <span className="text-2xs text-phase-test">No provider key</span>
            </div>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              Agents cannot run until a provider key is stored. This is the model-provider credential, not an
              Orbital account.
            </p>
            <Input
              type="password"
              autoComplete="off"
              className="h-7 font-mono text-2xs"
              placeholder="provider API key"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <Button
              size="xs"
              className="w-full"
              loading={submitting}
              disabled={apiKey.trim() === ""}
              onClick={() => void handleSignIn()}
            >
              Sign in
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
