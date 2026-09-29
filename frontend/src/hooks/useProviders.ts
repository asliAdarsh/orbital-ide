/**
 * Provider profiles for the React tree.
 *
 * Mirrors `useAuth`: each caller owns its own state — the gate in `App`, the first-run screen and
 * the settings list each fetch for themselves — while the profile store itself stays on the
 * backend. Callers never share a list, so none of them can be showing a stale one on behalf of
 * another.
 *
 * `status` starts at `"loading"` deliberately: the origin is resolved asynchronously, and a
 * `"ready"` first paint with no profiles would send someone with a configured provider to the
 * first-run screen for a frame.
 *
 * Every mutation adopts the list the backend returns instead of refetching: each endpoint answers
 * with the whole set precisely so the caller has nothing to reconcile.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage } from "@/lib/api";
import {
  providers,
  type ProviderConnectResult,
  type ProviderDraft,
  type ProviderList,
  type ProviderPatch,
  type ProviderPreset,
  type ProviderProfile,
  type ProviderTestResult,
} from "@/lib/providers";
import { useOrbitalProvider } from "@/hooks/useOrbitalProvider";
import { useAppStore } from "@/store/app-store";

export type ProvidersStatus = "loading" | "ready" | "error";

export interface ProvidersApi {
  /** `"error"` means the list could not be read; `error` says why and `refresh` retries. */
  status: ProvidersStatus;
  /** Every configured profile, in creation order. */
  profiles: ProviderProfile[];
  /** The providers a profile can be created from, as the backend serves them. */
  presets: ProviderPreset[];
  /** The profile a run talks to, or null when the user has configured none. */
  activeId: string | null;
  /** The sentence for the last failed call; null when there is nothing to report. */
  error: string | null;
  /**
   * The runtime's word about an edit that succeeded and still needs saying — today, that a key
   * entered for one host will now be sent to another. Null unless the last call carried one.
   */
  notice: string | null;
  /** True while a call is in flight — controls disable themselves on this. */
  busy: boolean;
  refresh(): Promise<void>;
  /** Resolves the profile the backend added, or null when it refused the draft. */
  create(draft: ProviderDraft): Promise<ProviderProfile | null>;
  /** Resolves false only when the backend refused the edit, with `error` saying why. */
  update(id: string, patch: ProviderPatch): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  activate(id: string): Promise<boolean>;
  /**
   * Ask the endpoint what it serves, store the answer, and re-read the list so the profile carries
   * the models it just stored.
   *
   * The endpoint's own verdict — a refused key, a list that came from the preset instead — is
   * returned rather than thrown: it is the answer to the question connect asks. Null only when the
   * call never landed.
   */
  connect(id: string): Promise<ProviderConnectResult | null>;
  /** The endpoint's own answer. Null only when the call itself could not be made. */
  test(id: string): Promise<ProviderTestResult | null>;
}

export function useProviders(): ProvidersApi {
  const backendBase = useAppStore((state) => state.backendBase);
  const [status, setStatus] = useState<ProvidersStatus>("loading");
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // An `orbital` profile's key is the account's ID token, and this is the one hook every signed-in
  // screen calls — the gate in `App` reads providers before anything else renders — so keeping that
  // token current belongs here rather than in a dialog that is only sometimes on screen. It writes
  // only when the value changes, and what it wrote is never shown back to it: `apiKeySet` is all
  // this list carries about a key, so the row catches up on the next read.
  useOrbitalProvider(profiles);

  // Closing a settings dialog mid-call must not write into a tree that is gone.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // Two loads can overlap — a retry while the first is still in flight — and only the later
  // answer is worth showing.
  const latest = useRef(0);

  /** The ids on screen now, so `create` can name the profile the response added. */
  const known = useRef<Set<string>>(new Set());

  /** Adopt a list the backend just returned. Presets are untouched: nothing here changes them. */
  const adopt = useCallback((next: ProviderList) => {
    known.current = new Set(next.profiles.map((profile) => profile.id));
    setProfiles(next.profiles);
    setActiveId(next.activeId);
    // Carried with the list rather than kept: it describes the call that just returned, and a
    // fresh read or a call that had nothing to say replaces it.
    setNotice(next.notice ?? null);
    setStatus("ready");
    setError(null);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    // The origin is resolved asynchronously; a call before it exists reports a runtime that is
    // not connected yet, which is not a state the user can act on.
    if (useAppStore.getState().backendBase === null) return;
    const id = latest.current + 1;
    latest.current = id;
    try {
      const [list, nextPresets] = await Promise.all([providers.list(), providers.presets()]);
      if (!live.current || latest.current !== id) return;
      adopt(list);
      setPresets(nextPresets);
    } catch (cause: unknown) {
      if (!live.current || latest.current !== id) return;
      setStatus("error");
      setError(errorMessage(cause));
    }
  }, [adopt]);

  useEffect(() => {
    void refresh();
  }, [refresh, backendBase]);

  /** The shared body of every edit: one busy flag, one error slot, one place to adopt the list. */
  const mutate = useCallback(
    async (action: () => Promise<ProviderList>): Promise<boolean> => {
      setBusy(true);
      try {
        adopt(await action());
        return true;
      } catch (cause: unknown) {
        if (live.current) setError(errorMessage(cause));
        return false;
      } finally {
        if (live.current) setBusy(false);
      }
    },
    [adopt],
  );

  const create = useCallback(
    async (draft: ProviderDraft): Promise<ProviderProfile | null> => {
      setBusy(true);
      try {
        const before = known.current;
        const next = await providers.create(draft);
        adopt(next);
        // The backend appends, but the id is what the caller needs — the response is the only
        // place that says which profile this call produced.
        return next.profiles.find((profile) => !before.has(profile.id)) ?? null;
      } catch (cause: unknown) {
        if (live.current) setError(errorMessage(cause));
        return null;
      } finally {
        if (live.current) setBusy(false);
      }
    },
    [adopt],
  );

  const update = useCallback(
    (id: string, patch: ProviderPatch) => mutate(() => providers.update(id, patch)),
    [mutate],
  );

  const remove = useCallback((id: string) => mutate(() => providers.remove(id)), [mutate]);

  const activate = useCallback((id: string) => mutate(() => providers.activate(id)), [mutate]);

  const connect = useCallback(
    async (id: string): Promise<ProviderConnectResult | null> => {
      setBusy(true);
      try {
        const result = await providers.connect(id);
        // Connect writes to the same store the list is read from, so the list is re-read rather
        // than left describing the profile as it was before the call.
        await refresh();
        return result;
      } catch (cause: unknown) {
        // A refused key is answered, not thrown; reaching here means the call never landed.
        if (live.current) setError(errorMessage(cause));
        return null;
      } finally {
        if (live.current) setBusy(false);
      }
    },
    [refresh],
  );

  const test = useCallback(async (id: string): Promise<ProviderTestResult | null> => {
    setBusy(true);
    try {
      return await providers.test(id);
    } catch (cause: unknown) {
      // A refused key is answered, not thrown; reaching here means the call never landed.
      if (live.current) setError(errorMessage(cause));
      return null;
    } finally {
      if (live.current) setBusy(false);
    }
  }, []);

  return {
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
  };
}
