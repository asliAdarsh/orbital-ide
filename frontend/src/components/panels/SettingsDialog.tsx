import { useEffect, useState } from "react";

import { useAppStore } from "@/store/app-store";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ConfigResponse, ConfigUpdate, HealthResponse } from "@/types/protocol";
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
import { Separator } from "@/components/ui/separator";
import { SectionLabel } from "@/components/common/SectionLabel";
import { StatusDot } from "@/components/common/StatusDot";
import { toast } from "@/components/common/Toaster";
import { ProvidersPanel } from "@/components/settings/ProvidersPanel";

/** Panel dimensions the user may have dragged; clearing them restores the defaults. */
const PANEL_SIZE_KEYS = [
  "orbital.leftSidebarWidth",
  "orbital.rightSidebarWidth",
  "orbital.bottomPanelHeight",
] as const;

/**
 * The editable slice of the config, as typed into the form: every field present.
 *
 * The model, the endpoint and the key are deliberately absent. They belong to a provider profile
 * now, and a second way to set them here would be a way to set the one a run does not use.
 */
type Draft = Omit<Required<ConfigUpdate>, "model" | "baseUrl" | "apiKey">;

const LABEL = "text-2xs text-muted-foreground";
const FIELD = "h-7 font-mono text-2xs";

/**
 * The credential row's wording, from the last authenticated call the runtime made.
 *
 * `llmConfigured` is deliberately not consulted: it describes the `ORBITAL_LLM_*` values in
 * `.env`, and a provider profile overrides those — so it can read "not configured" while a run
 * works, and "configured" while nothing does. `llmCredential` is only ever set by a real call, so
 * it is the one field that still answers whether the key a run would use is accepted.
 */
function credentialStatus(health: HealthResponse | null): { label: string; warn: boolean } {
  if (health === null) return { label: "—", warn: false };
  if (health.llmCredential === "rejected") return { label: "rejected by the gateway", warn: true };
  if (health.llmCredential === "ok") return { label: "accepted by the gateway", warn: false };
  return { label: "not verified yet", warn: false };
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function SettingsDialog() {
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const autoAdvance = useAppStore((s) => s.autoAdvance);
  const setAutoAdvance = useAppStore((s) => s.setAutoAdvance);
  const socketStatus = useAppStore((s) => s.socketStatus);
  const backendBase = useAppStore((s) => s.backendBase);

  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Everything is read fresh each time the page opens: the backend config can change
  // underneath us (another window, a restart), and the API key is never cached here.
  useEffect(() => {
    if (!settingsOpen) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void Promise.all([api.config(), api.health()])
      .then(([nextConfig, nextHealth]) => {
        if (cancelled) return;
        setConfig(nextConfig);
        setHealth(nextHealth);
        setDraft({
          commandTimeout: nextConfig.commandTimeout,
          maxOutputBytes: nextConfig.maxOutputBytes,
          contextWindow: nextConfig.contextWindow,
          maxTokens: nextConfig.maxTokens,
          allowedRoots: nextConfig.allowedRoots,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = errorMessage(err);
        setLoadError(message);
        toast.error(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [settingsOpen, reloadNonce]);

  const handleSave = async () => {
    if (config === null || draft === null) return;
    const patch: ConfigUpdate = {};
    if (draft.contextWindow !== config.contextWindow) patch.contextWindow = draft.contextWindow;
    if (draft.maxTokens !== config.maxTokens) patch.maxTokens = draft.maxTokens;
    if (draft.commandTimeout !== config.commandTimeout) patch.commandTimeout = draft.commandTimeout;
    if (draft.maxOutputBytes !== config.maxOutputBytes) patch.maxOutputBytes = draft.maxOutputBytes;
    const roots = draft.allowedRoots.map((root) => root.trim()).filter((root) => root !== "");
    if (roots.join("\n") !== config.allowedRoots.join("\n")) patch.allowedRoots = roots;

    if (Object.keys(patch).length === 0) {
      toast.info("Nothing to save.");
      return;
    }

    setSaving(true);
    try {
      const result = await api.updateConfig(patch);
      setConfig(await api.config());
      setDraft({ ...draft, allowedRoots: roots });
      toast.success(
        result.changed.length > 0 ? `Updated ${result.changed.join(", ")}` : "Configuration unchanged.",
      );
    } catch (err: unknown) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleResetPanels = () => {
    for (const key of PANEL_SIZE_KEYS) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Storage can be unavailable (private mode); nothing to reset then.
      }
    }
    window.location.reload();
  };

  const credential = credentialStatus(health);

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      {/* Deliberately smaller than the window: settings read alongside the code, not instead of it. */}
      <DialogContent className="max-h-[80vh] w-[min(48rem,90vw)] max-w-3xl gap-4 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Runtime configuration stored by the local backend. Values apply to new runs.
          </DialogDescription>
        </DialogHeader>

        <ProvidersPanel />

        <Separator />

        {loading ? (
          <p className="py-8 text-center text-2xs text-muted-foreground">Loading configuration…</p>
        ) : loadError !== null ? (
          <div className="flex flex-col items-start gap-2 py-4">
            <p className="text-2xs text-phase-test">{loadError}</p>
            <Button size="xs" variant="secondary" onClick={() => setReloadNonce((nonce) => nonce + 1)}>
              Retry
            </Button>
          </div>
        ) : config !== null && draft !== null ? (
          <>
            <div className="flex flex-col gap-2">
              <SectionLabel className="-mx-2">Model limits</SectionLabel>

              <label className="grid grid-cols-[10rem_1fr] items-center gap-3">
                <span className={LABEL}>Context window</span>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  className={FIELD}
                  value={draft.contextWindow}
                  onChange={(event) =>
                    setDraft({ ...draft, contextWindow: Math.max(0, Math.trunc(Number(event.target.value) || 0)) })
                  }
                />
              </label>

              <label className="grid grid-cols-[10rem_1fr] items-center gap-3">
                <span className={LABEL}>Max tokens</span>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  className={FIELD}
                  value={draft.maxTokens}
                  onChange={(event) =>
                    setDraft({ ...draft, maxTokens: Math.max(0, Math.trunc(Number(event.target.value) || 0)) })
                  }
                />
              </label>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
              <SectionLabel className="-mx-2">Execution</SectionLabel>

              <label className="grid grid-cols-[10rem_1fr] items-center gap-3">
                <span className={LABEL}>Command timeout (s)</span>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  className={FIELD}
                  value={draft.commandTimeout}
                  onChange={(event) =>
                    setDraft({ ...draft, commandTimeout: Math.max(0, Math.trunc(Number(event.target.value) || 0)) })
                  }
                />
              </label>

              <label className="grid grid-cols-[10rem_1fr] items-center gap-3">
                <span className={LABEL}>Max output bytes</span>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  className={FIELD}
                  value={draft.maxOutputBytes}
                  onChange={(event) =>
                    setDraft({ ...draft, maxOutputBytes: Math.max(0, Math.trunc(Number(event.target.value) || 0)) })
                  }
                />
              </label>

              <label className="grid grid-cols-[10rem_1fr] items-center gap-3">
                <span className={LABEL}>Allowed roots</span>
                <Input
                  className={FIELD}
                  placeholder="C:/work, D:/src"
                  value={draft.allowedRoots.join(", ")}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      allowedRoots: event.target.value.split(",").map((root) => root.trim()),
                    })
                  }
                />
              </label>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
              <SectionLabel className="-mx-2">Interface</SectionLabel>

              <label className="grid grid-cols-[10rem_1fr] items-center gap-3">
                <span className={LABEL}>Auto-advance</span>
                <span className={cn(LABEL, "flex items-center gap-1.5")}>
                  <input
                    type="checkbox"
                    className="h-3 w-3 accent-primary"
                    checked={autoAdvance}
                    onChange={(event) => setAutoAdvance(event.target.checked)}
                  />
                  run all phases without stopping
                </span>
              </label>

              <div className="grid grid-cols-[10rem_1fr] items-center gap-3">
                <span className={LABEL}>Panel sizes</span>
                <div>
                  <Button variant="secondary" size="xs" onClick={handleResetPanels}>
                    Reset panel sizes
                  </Button>
                </div>
              </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
              <SectionLabel className="-mx-2">Runtime</SectionLabel>
              <div className="grid grid-cols-[10rem_1fr] items-center gap-x-3 gap-y-1 font-mono text-2xs">
                <span className={LABEL}>Version</span>
                <span className="truncate text-foreground">{health?.version ?? "—"}</span>

                <span className={LABEL}>Protocol</span>
                <span className="text-foreground">{health ? `v${health.protocolVersion}` : "—"}</span>

                <span className={LABEL}>LLM credential</span>
                <span
                  className={cn(credential.warn ? "text-phase-test" : "text-foreground")}
                  title={health?.llmCredentialDetail ?? undefined}
                >
                  {credential.label}
                </span>

                <span className={LABEL}>Missing binaries</span>
                <span
                  className={cn(
                    health !== null && health.missingBinaries.length > 0 ? "text-phase-test" : "text-foreground",
                  )}
                >
                  {health === null
                    ? "—"
                    : health.missingBinaries.length > 0
                      ? health.missingBinaries.join(", ")
                      : "none"}
                </span>

                <span className={LABEL}>Uptime</span>
                <span className="text-foreground">{health ? formatUptime(health.uptimeSeconds) : "—"}</span>

                <span className={LABEL}>Socket</span>
                <span className="flex items-center gap-1.5 text-foreground">
                  <StatusDot
                    state={
                      socketStatus === "open" ? "online" : socketStatus === "connecting" ? "queued" : "offline"
                    }
                  />
                  {socketStatus}
                </span>

                <span className={LABEL}>Backend</span>
                <span className="truncate text-foreground">{backendBase ?? "—"}</span>
              </div>
            </div>
          </>
        ) : null}

        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={() => setSettingsOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={saving}
            disabled={config === null || draft === null || saving || loading}
            onClick={() => void handleSave()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
