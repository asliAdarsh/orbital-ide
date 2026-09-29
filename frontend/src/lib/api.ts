/** REST client for the Orbital backend. Every call throws {@link ApiError} on failure. */

import { getAuthToken } from "@/lib/backend";
import { useAppStore } from "@/store/app-store";
import type {
  BranchStrategiesResponse,
  BranchStrategyInfo,
  CapabilitiesResponse,
  CapabilityInfo,
  ChatPatch,
  ChatResponse,
  ChatStateResponse,
  ChatsResponse,
  CommandResult,
  ConfigResponse,
  ConfigUpdate,
  ConfigUpdateResponse,
  CreateChatRequest,
  DocsResponse,
  FileContent,
  FileNode,
  GitStatus,
  HealthResponse,
  PhaseInfo,
  PickFolderResponse,
  ProjectEntry,
  ProjectPatch,
  ProjectResponse,
  ProjectsResponse,
  SearchResponse,
  SessionState,
  SkillResponse,
  SkillsResponse,
} from "@/types/protocol";

/**
 * One line for an error slot.
 *
 * `ApiError` carries the backend's own explanation — a validation message, a refused path — which
 * is always more useful than an HTTP status, and a thrown non-Error gets the caller's wording
 * rather than `[object Object]`.
 */
export function errorMessage(cause: unknown, fallback?: string): string {
  if (cause instanceof ApiError) return cause.detail ?? cause.message;
  if (cause instanceof Error) return cause.message;
  return fallback ?? String(cause);
}

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string | null;

  constructor(message: string, status: number, detail: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

function origin(): string {
  const base = useAppStore.getState().backendBase;
  if (!base) throw new ApiError("The Orbital runtime is not connected yet.", 0);
  return base;
}

/** Absolute URL for a backend path, using the resolved origin. */
export function apiUrl(path: string): string {
  return `${origin()}${path.startsWith("/") ? path : `/${path}`}`;
}

async function readDetail(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    return typeof body.detail === "string" ? body.detail : null;
  } catch {
    // A non-JSON body means the backend never handled the request (proxy, crash).
    return null;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  // The runtime refuses a caller without its token; the boot sequence is what supplies one, and
  // it reports the case where nothing did — see useBackendBoot.
  const token = getAuthToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(apiUrl(path), { ...init, headers });
  } catch (cause) {
    throw new ApiError(
      `Cannot reach the Orbital runtime at ${origin()}.`,
      0,
      cause instanceof Error ? cause.message : null,
    );
  }
  if (!response.ok) {
    const detail = await readDetail(response);
    throw new ApiError(detail ?? `${response.status} ${response.statusText}`, response.status, detail);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { headers: { Accept: "application/json" } });
}

export async function apiSend<T>(
  path: string,
  body?: unknown,
  method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
): Promise<T> {
  return request<T>(path, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const quote = (value: string) => encodeURIComponent(value);

export const api = {
  health: () => apiGet<HealthResponse>("/api/health"),
  config: () => apiGet<ConfigResponse>("/api/config"),

  /** Filesystem search for the nav's search bar. */
  search: (query: string, limit = 50) =>
    apiGet<SearchResponse>(`/api/files/search?q=${encodeURIComponent(query)}&limit=${limit}`),
  /** Persist settings and apply what can be applied without a restart. */
  updateConfig: (patch: ConfigUpdate) => apiSend<ConfigUpdateResponse>("/api/config", patch, "PUT"),
  phases: async (): Promise<PhaseInfo[]> => (await apiGet<{ phases: PhaseInfo[] }>("/api/phases")).phases,
  /** The branching models a project can follow. Served by the runtime so the ids never drift. */
  branchStrategies: async (): Promise<BranchStrategyInfo[]> =>
    (await apiGet<BranchStrategiesResponse>("/api/branch-strategies")).strategies,
  /** What the agent may be allowed to do, with the mode defaults. Served, never hardcoded. */
  capabilities: async (): Promise<CapabilityInfo[]> =>
    (await apiGet<CapabilitiesResponse>("/api/capabilities")).capabilities,

  project: () => apiGet<ProjectResponse>("/api/project"),
  openProject: (path: string) => apiSend<ProjectResponse>("/api/project/open", { path }),

  /** The launcher's registry, most recently opened first. */
  listProjects: async (): Promise<ProjectEntry[]> =>
    (await apiGet<ProjectsResponse>("/api/projects")).projects,
  /**
   * Register a new project. Creating one that already exists returns the existing entry.
   *
   * `repository` and `branchStrategy` travel together: the backend refuses a repository with no
   * strategy and a strategy with no repository.
   */
  createProject: async (input: {
    parent: string;
    name: string;
    description: string | null;
    repository: string | null;
    branchStrategy: string | null;
  }): Promise<ProjectEntry> => (await apiSend<{ project: ProjectEntry }>("/api/projects", input)).project,
  /** Rename, re-describe, star or clear a project's recents history. Returns the whole list. */
  updateProject: async (id: string, patch: ProjectPatch): Promise<ProjectEntry[]> =>
    (await apiSend<ProjectsResponse>(`/api/projects/${quote(id)}`, patch, "PATCH")).projects,
  /**
   * Forget a project, and with ``deleteFiles`` also delete its folder from disk.
   *
   * The flag is explicit because the two are world apart: one edits a list, the other destroys
   * work, and a caller that forgets the argument must get the harmless one.
   */
  deleteProject: async (id: string, deleteFiles: boolean): Promise<ProjectEntry[]> =>
    (
      await apiSend<ProjectsResponse>(
        `/api/projects/${quote(id)}?files=${deleteFiles ? "true" : "false"}`,
        undefined,
        "DELETE",
      )
    ).projects,
  /** The app's own documentation, served by the runtime so it works offline. */
  docs: () => apiGet<DocsResponse>("/api/docs"),
  /** Ask the local runtime to show the OS folder chooser and return an absolute path. */
  pickFolder: (title?: string, initialDir?: string) =>
    apiSend<PickFolderResponse>("/api/system/pick-folder", {
      title: title ?? null,
      initialDir: initialDir ?? null,
    }),
  tree: async (depth = 4): Promise<FileNode> =>
    (await apiGet<{ root: FileNode }>(`/api/project/tree?depth=${depth}`)).root,

  readFile: (path: string) => apiGet<FileContent>(`/api/files/content?path=${quote(path)}`),
  writeFile: (path: string, content: string) =>
    apiSend<FileContent>("/api/files/content", { path, content }, "PUT"),
  deleteFile: (path: string) => apiSend<{ ok: boolean }>(`/api/files?path=${quote(path)}`, undefined, "DELETE"),

  gitStatus: () => apiGet<GitStatus>("/api/git/status"),
  gitInit: (remote?: string) => apiSend<CommandResult>("/api/git/init", { remote: remote ?? null }),
  gitCommit: (message: string, paths?: string[]) =>
    apiSend<CommandResult>("/api/git/commit", { message, paths: paths ?? null }),
  gitPush: (remote?: string, branch?: string) =>
    apiSend<CommandResult>("/api/git/push", { remote: remote ?? null, branch: branch ?? null }),

  exec: (command: string, cwd?: string, timeout?: number) =>
    apiSend<CommandResult>("/api/terminal/exec", {
      command,
      cwd: cwd ?? null,
      timeout: timeout ?? null,
    }),

  session: (sessionId: string) => apiGet<SessionState>(`/api/agents/session/${quote(sessionId)}`),
  cancelAgent: (sessionId: string) => apiSend<{ ok: boolean }>("/api/agents/cancel", { sessionId }),

  /**
   * The saved chats, newest first.
   *
   * `workspace` narrows to one folder and `all` widens to every folder, which are the two scopes
   * the sessions panel offers; passing neither leaves the backend's own default. The two are not
   * combined here because a caller that means "everything" must not also look filtered.
   */
  listChats: async (opts: { workspace?: string | null; all?: boolean } = {}): Promise<ChatsResponse> => {
    const params = new URLSearchParams();
    if (opts.all) params.set("all", "true");
    else if (opts.workspace) params.set("workspace", opts.workspace);
    const query = params.toString();
    return apiGet<ChatsResponse>(`/api/chats${query === "" ? "" : `?${query}`}`);
  },
  /** The row's metadata plus the runtime state behind it — what "refresh this chat" fetches. */
  chat: (id: string) => apiGet<ChatStateResponse>(`/api/chats/${quote(id)}`),
  createChat: (input: CreateChatRequest = {}) => apiSend<ChatResponse>("/api/chats", input),
  updateChat: (id: string, patch: ChatPatch) =>
    apiSend<ChatResponse>(`/api/chats/${quote(id)}`, patch, "PATCH"),
  deleteChat: (id: string) => apiSend<ChatsResponse>(`/api/chats/${quote(id)}`, undefined, "DELETE"),
  clearChat: (id: string) => apiSend<ChatStateResponse>(`/api/chats/${quote(id)}/clear`),

  /**
   * The skills a workspace and this machine offer. Read-only: nothing here writes or runs one.
   *
   * `workspace` names which workspace's skills are wanted; a workspace skill id is only unique
   * within its workspace, so a caller whose chat is not the open project must pass it.
   */
  skills: async (workspace?: string | null): Promise<SkillsResponse> =>
    apiGet<SkillsResponse>(`/api/skills${workspace ? `?workspace=${quote(workspace)}` : ""}`),
  skill: (id: string, workspace?: string | null) =>
    apiGet<SkillResponse>(`/api/skills/${quote(id)}${workspace ? `?workspace=${quote(workspace)}` : ""}`),
};
