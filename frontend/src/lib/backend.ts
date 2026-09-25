/** Runtime discovery: where is the Python agent backend, and who owns it? */

import { invoke } from "@tauri-apps/api/core";

export interface BackendTarget {
  /** Origin without a trailing slash, e.g. `http://127.0.0.1:8765`. */
  baseUrl: string;
  port: number;
  /** True when the Tauri host spawned and supervises the sidecar process. */
  managed: boolean;
}

/** Shape returned by the Rust `backend_info` command. */
interface BackendInfo {
  port: number;
  baseUrl: string;
  managed: boolean;
  pid: number | null;
  status: string;
}

const DEFAULT_PORT = 8765;

/** True when running inside the Tauri webview rather than a plain browser tab. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Resolve the backend origin.
 *
 * Inside Tauri the Rust host picks a free port, so the port must be queried rather
 * than assumed. In a plain browser (the `npm run dev` workflow) it falls back to the
 * fixed port so the frontend can be developed against a manually started backend.
 */
export async function resolveBackendTarget(): Promise<BackendTarget> {
  if (isTauri()) {
    const info = await invoke<BackendInfo>("backend_info");
    return { baseUrl: info.baseUrl.replace(/\/$/, ""), port: info.port, managed: info.managed };
  }
  const override = import.meta.env.VITE_ORBITAL_API as string | undefined;
  const baseUrl = (override ?? `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/$/, "");
  return { baseUrl, port: DEFAULT_PORT, managed: false };
}

/** Convert an HTTP origin into the WebSocket endpoint the backend exposes. */
export function websocketUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, "ws")}/ws`;
}
