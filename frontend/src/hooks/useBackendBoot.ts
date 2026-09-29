/**
 * Boot sequence: find the agent runtime, then wait for it to answer `/api/health`.
 *
 * The sidecar needs a moment to start (it is a fresh Python process), so the probe
 * retries with a bounded backoff instead of failing on the first refusal. The outcome
 * is surfaced through the store so every panel sees the same health snapshot.
 */

import { useCallback, useEffect, useState } from "react";

import { api, ApiError } from "@/lib/api";
import { getAuthToken, resolveBackendTarget, setAuthToken } from "@/lib/backend";
import { currentSessionId } from "@/hooks/useAgentSocket";
import { useAppStore } from "@/store/app-store";

const MAX_ATTEMPTS = 20;
const BASE_DELAY_MS = 400;
const MAX_DELAY_MS = 3_000;

/**
 * What the boot screen says when nothing supplied a token.
 *
 * The runtime refuses every caller without one, so probing anyway would only paint a wall of
 * identical 401s over the one sentence that explains what is missing.
 */
const NO_RUNTIME_TOKEN =
  "This build has no Orbital runtime token. Start the backend with `npm run backend:dev` — it " +
  "mints a token and writes VITE_ORBITAL_TOKEN into frontend/.env.local for the dev server; " +
  "the desktop app reads it from the Tauri host instead.";

export interface BackendBoot {
  ready: boolean;
  error: string | null;
  retry(): void;
}

export function useBackendBoot(): BackendBoot {
  const base = useAppStore((state) => state.backendBase);
  const [attemptKey, setAttemptKey] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve the origin once: Tauri hands out a dynamic port and the token that goes with it, the
  // browser build a fixed port and the dev server's token.
  useEffect(() => {
    let cancelled = false;
    resolveBackendTarget()
      .then((target) => {
        if (cancelled) return;
        setAuthToken(target.token);
        if (target.token === null) {
          // No origin is published either: a request would only produce an unexplained refusal.
          setError(NO_RUNTIME_TOKEN);
          return;
        }
        useAppStore.getState().setBackendBase(target.baseUrl);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(
          cause instanceof Error
            ? `Could not reach the desktop host: ${cause.message}`
            : "Could not reach the desktop host.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [attemptKey]);

  useEffect(() => {
    if (!base || getAuthToken() === null) return;
    let cancelled = false;
    let timer: number | null = null;
    let attempt = 0;

    const probe = async () => {
      try {
        const health = await api.health();
        if (cancelled) return;
        const store = () => useAppStore.getState();
        store().setHealth(health);
        store().pushLog("info", `runtime ready on ${base} (model ${health.model})`);
        if (health.missingBinaries.length > 0) {
          store().pushLog("warn", `not found on PATH: ${health.missingBinaries.join(", ")}`);
        }
        if (!health.llmConfigured) {
          store().pushLog("warn", "ORBITAL_LLM_API_KEY is not set — agent runs are disabled.");
        }
        // The backend owns the workspace and the session, so a UI reload re-attaches to
        // whatever it still holds rather than showing an empty shell.
        try {
          const project = await api.project();
          if (cancelled) return;
          store().setProject(project);
          if (project.projectPath) {
            const [tree, session] = await Promise.all([api.tree(), api.session(currentSessionId())]);
            if (cancelled) return;
            store().setTree(tree);
            store().applySession(session);
          }
        } catch (cause) {
          if (!cancelled) {
            store().pushLog(
              "warn",
              `could not restore the previous workspace: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            );
          }
        }
        setReady(true);
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        attempt += 1;
        const detail =
          cause instanceof ApiError ? (cause.detail ?? cause.message) : "The agent runtime did not respond.";
        if (attempt >= MAX_ATTEMPTS) {
          setError(detail);
          return;
        }
        setError(detail);
        timer = window.setTimeout(() => void probe(), Math.min(BASE_DELAY_MS * attempt, MAX_DELAY_MS));
      }
    };

    void probe();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [base, attemptKey]);

  const retry = useCallback(() => {
    setError(null);
    setReady(false);
    setAttemptKey((key) => key + 1);
  }, []);

  return { ready, error, retry };
}
