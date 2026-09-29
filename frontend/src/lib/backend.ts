/** Runtime discovery: where is the Python agent backend, and who owns it? */

import { invoke } from "@tauri-apps/api/core";

export interface BackendTarget {
  /** Origin without a trailing slash, e.g. `http://127.0.0.1:8765`. */
  baseUrl: string;
  port: number;
  /** True when the Tauri host spawned and supervises the sidecar process. */
  managed: boolean;
  /**
   * The secret every request and socket has to present, or `null` when nothing supplied one.
   *
   * The host mints it for the sidecar and hands it back here; the browser workflow gets it from
   * `VITE_ORBITAL_TOKEN`, which `npm run backend:dev` writes. `null` is not "no authentication":
   * the runtime refuses a caller without it, so the boot sequence reports it rather than probing.
   */
  token: string | null;
}

/** Shape returned by the Rust `backend_info` command. */
interface BackendInfo {
  port: number;
  baseUrl: string;
  managed: boolean;
  pid: number | null;
  status: string;
  token: string | null;
}

const DEFAULT_PORT = 8765;

/** True when running inside the Tauri webview rather than a plain browser tab. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * The runtime token, resolved once at boot.
 *
 * Kept beside the origin it belongs to, because the two always change together — a restart moves
 * the port and mints a new token. Every request and the socket read it from here, so exactly one
 * place decides what is presented.
 */
let authToken: string | null = null;

/** Remember the token every request and socket has to present. `null` or empty clears it. */
export function setAuthToken(token: string | null): void {
  authToken = token && token.length > 0 ? token : null;
}

/** The token in use, or `null` when nothing has supplied one. */
export function getAuthToken(): string | null {
  return authToken;
}

/**
 * Resolve the backend origin and the token that answers it.
 *
 * Inside Tauri the Rust host picks a free port and mints the token, so both must be queried rather
 * than assumed. In a plain browser (the `npm run dev` workflow) the port falls back to the fixed
 * one and the token comes from the dev server's environment — the value `npm run backend:dev`
 * wrote and passed to the backend. A production bundle is served by the desktop host and takes the
 * token from it instead; nothing is baked into the packaged app.
 */
export async function resolveBackendTarget(): Promise<BackendTarget> {
  if (isTauri()) {
    const info = await invoke<BackendInfo>("backend_info");
    return {
      baseUrl: info.baseUrl.replace(/\/$/, ""),
      port: info.port,
      managed: info.managed,
      token: info.token,
    };
  }
  const override = import.meta.env.VITE_ORBITAL_API as string | undefined;
  const devToken = import.meta.env.VITE_ORBITAL_TOKEN as string | undefined;
  const baseUrl = (override ?? `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/$/, "");
  return { baseUrl, port: DEFAULT_PORT, managed: false, token: devToken ? devToken : null };
}

/** Convert an HTTP origin into the WebSocket endpoint the backend exposes. */
export function websocketUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, "ws")}/ws`;
}
