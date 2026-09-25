/**
 * Open a workspace folder and load it into the store.
 *
 * Folder selection differs by host, and neither path asks the user to type anything:
 *  - **desktop** — the Tauri dialog plugin shows the OS picker.
 *  - **browser** — no web API can return an absolute path (`showDirectoryPicker()` yields an
 *    opaque handle), so the local Python runtime shows the dialog and reports the path.
 *
 * When the runtime cannot show one, `open()` records that in `error` and callers fall back
 * to the manual path field.
 */

import { useCallback, useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";

import { api, ApiError } from "@/lib/api";
import { isTauri } from "@/lib/backend";
import { useAppStore } from "@/store/app-store";
import type { PickFolderResponse } from "@/types/protocol";

const PICK_TITLE = "Open project folder";

/**
 * Ask for a directory, however this build can.
 *
 * Exported because the launcher needs the same answer and must not grow a second copy of the
 * host rule: inside Tauri the OS dialog belongs to the host, and in a plain browser no web API
 * can return an absolute path, so the local runtime shows it instead.
 */
export async function chooseFolderPath(title: string = PICK_TITLE): Promise<PickFolderResponse> {
  if (isTauri()) {
    const picked = await openFolderDialog({ directory: true, multiple: false, title });
    return { path: typeof picked === "string" ? picked : null, available: true, reason: null };
  }
  return api.pickFolder(title);
}

export interface OpenProject {
  open(path?: string): Promise<void>;
  opening: boolean;
  error: string | null;
}

export function useOpenProject(): OpenProject {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async (path?: string) => {
    const store = () => useAppStore.getState();
    setOpening(true);
    setError(null);
    try {
      let target = path?.trim();
      if (!target) {
        const picked = await chooseFolderPath();
        if (!picked.path) {
          // A cancelled dialog is not an error, but a picker that could not run must say so.
          if (picked.reason) setError(picked.reason);
          return;
        }
        target = picked.path;
      }
      const project = await api.openProject(target);
      store().setProject(project);
      store().setTree(await api.tree());
      store().pushLog("info", `opened ${project.projectPath ?? target}`);
      if (!project.git.available) {
        store().pushLog("warn", "git was not found on PATH — phase 5 will be unavailable.");
      }
    } catch (cause) {
      const message =
        cause instanceof ApiError
          ? (cause.detail ?? cause.message)
          : cause instanceof Error
            ? cause.message
            : "Could not open that folder.";
      setError(message);
      useAppStore.getState().pushLog("error", `could not open project: ${message}`);
    } finally {
      setOpening(false);
    }
  }, []);

  return { open, opening, error };
}
