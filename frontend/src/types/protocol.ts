/**
 * Orbital wire protocol — THE single source of truth for the React ⇄ FastAPI bridge.
 *
 * Every frame on the WebSocket is an `Envelope` wrapping a discriminated `payload`.
 * All field names are camelCase on the wire; the Python side serialises pydantic
 * models with `by_alias=True` so both ends agree without translation layers.
 */

export const PROTOCOL_VERSION = 1 as const;

/** Pipeline phases, in execution order. */
export const PHASES = ["plan", "design", "build", "test", "sync"] as const;
export type Phase = (typeof PHASES)[number];

/** Agent identities. One supervisor plus three specialists. */
export const AGENTS = ["orchestrator", "architect", "code_engine", "qa"] as const;
export type AgentId = (typeof AGENTS)[number];

/**
 * Reasoning-effort levels the gateway accepts, weakest first. The list is closed: the backend
 * refuses anything else instead of silently dropping it, so the composer only ever offers these
 * and the frame only ever carries one of them. Mirrors `REASONING_EFFORTS` in models.py.
 */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Narrows a stored preference or a `<select>` value back onto the wire values. */
export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * Capabilities the user may allow an agent, in the order the composer's config dialog renders
 * them. Closed like the reasoning levels: the backend refuses an id it does not know rather than
 * ignoring it, so this mirrors the ids `GET /api/capabilities` serves and the frame may only ever
 * carry one of them.
 */
export const CAPABILITY_IDS = ["web", "commands", "todos", "write", "tests", "git"] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/** Narrows a catalogue id or a stored preference back onto the wire values. */
export function isCapabilityId(value: string): value is CapabilityId {
  return (CAPABILITY_IDS as readonly string[]).includes(value);
}

/** How the agent treats a command it wants to run. */
export type PermissionMode = "ask" | "allow_all";

export type PhaseStatus = "idle" | "queued" | "running" | "done" | "error";
/**
 * `paused` is a step boundary, not a mid-token freeze: the run stopped before its next model or
 * tool step and its state is preserved, so `resume` continues it where `cancelled` would discard it.
 */
export type RunStatus = "idle" | "running" | "paused" | "done" | "error" | "cancelled";

/** Static description of a phase, served by `GET /api/phases`. Keep in sync with `PHASE_SPECS` in models.py. */
export interface PhaseInfo {
  id: Phase;
  index: number;
  title: string;
  agent: AgentId;
  /** Artefact the phase is responsible for producing. */
  deliverable: string;
  description: string;
}

/**
 * Where the pipeline keeps its own files inside a project.
 *
 * Everything Orbital writes about a project — the plan, the design mocks, the test report and the
 * orchestrator's own state file — lives under one `agent/` folder, so the project's root holds the
 * application and nothing else.
 */
export const AGENT_DIR = "agent";
export const DESIGN_DIR = `${AGENT_DIR}/design`;
export const PLAN_PATH = `${AGENT_DIR}/plan.md`;
export const TEST_REPORT_PATH = `${AGENT_DIR}/test-report.md`;
export const AGENTS_MD_PATH = `${AGENT_DIR}/Agents.md`;

export const PHASE_SPECS: readonly PhaseInfo[] = [
  {
    id: "plan",
    index: 1,
    title: "Planning & Research",
    agent: "architect",
    deliverable: PLAN_PATH,
    description:
      "Talks the idea through with you, then writes the agreed plan to agent/plan.md.",
  },
  {
    id: "design",
    index: 2,
    title: "UI Design",
    agent: "architect",
    deliverable: `${DESIGN_DIR}/*.html`,
    description:
      "Builds one real HTML page per screen in agent/design/, which you can open and preview, and revise on request.",
  },
  {
    id: "build",
    index: 3,
    title: "Build Application",
    agent: "code_engine",
    deliverable: "source tree",
    description:
      "Writes the codebase file-by-file using local file tools and installs dependencies in the workspace shell.",
  },
  {
    id: "test",
    index: 4,
    title: "Test & Debug",
    agent: "qa",
    deliverable: TEST_REPORT_PATH,
    description:
      "Runs the project's test and lint commands, parses failures, and hands structured patches to the Code Engine.",
  },
  {
    id: "sync",
    index: 5,
    title: "Repository Sync",
    agent: "code_engine",
    deliverable: "git remote",
    description:
      "Stages, commits and pushes the verified workspace to the configured remote repository.",
  },
] as const;

// ---------------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------------

export interface FileNode {
  name: string;
  /** Path relative to the project root, always POSIX-separated. */
  path: string;
  type: "file" | "directory";
  size: number;
  children?: FileNode[];
  /** True when the tree walker skipped this directory (node_modules, .git, dist…). */
  ignored?: boolean;
}

export interface FileContent {
  path: string;
  content: string;
  /** Monaco language id. */
  language: string;
  /** True when the file exceeded the read limit and `content` was clipped. */
  truncated: boolean;
  bytes: number;
}

export interface GitChange {
  path: string;
  /** Porcelain status code, e.g. "M", "??", "A". */
  status: string;
  staged: boolean;
}

export interface GitStatus {
  /** False when the `git` binary is not on PATH. */
  available: boolean;
  /** False when the workspace is not inside a git repository. */
  repo: boolean;
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  remote: string | null;
  changed: GitChange[];
  /** Populated when `available` or `repo` is false, or when a git call failed. */
  error: string | null;
}

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True when output exceeded ORBITAL_MAX_OUTPUT_BYTES and was clipped. */
  truncated: boolean;
  /** True when the process was killed after exceeding its timeout. */
  timedOut: boolean;
  /** True when the user cancelled the command from the terminal panel. */
  cancelled: boolean;
  /** Set when the command could not be launched at all (missing binary, EACCES…). */
  error: string | null;
}

export interface ToolCall {
  id: string;
  /** Tool name, e.g. "write_file" | "run_command" | "git_push". */
  name: string;
  args: Record<string, unknown>;
  startedAt: number;
  agent: AgentId;
}

export interface ToolResult {
  id: string;
  name: string;
  ok: boolean;
  durationMs: number;
  /** Rendered output shown in the execution inspector. */
  output: string;
  truncated: boolean;
  error: string | null;
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type TodoStatus = "pending" | "in_progress" | "completed";

/**
 * One row of the agent's working list. The agent publishes the whole list on every update, so a
 * row's identity is its position and content, not an id it would have to track across calls.
 */
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  agent: AgentId;
  content: string;
  /** Null for orchestrator-level chatter not bound to a phase. */
  phase: Phase | null;
  createdAt: number;
  /** True while tokens are still streaming into `content`. */
  streaming: boolean;
  toolCalls: ToolCall[];
}

export interface SessionState {
  sessionId: string;
  projectPath: string | null;
  activePhase: Phase;
  status: RunStatus;
  phases: Record<Phase, PhaseStatus>;
  messages: ChatMessage[];
  /** Named artefacts produced so far, keyed by workspace-relative path (agent/plan.md…). */
  artifacts: Record<string, string>;
  /** Last fatal error for the session, if any. */
  error: string | null;
  /** What this session has consumed so far. */
  usage: UsageSnapshot;
  /**
   * Commands still held for a decision. The state frame is the socket's resync point, so a client
   * that reconnects mid-request recovers the approval card it never saw instead of stalling.
   */
  pendingCommands: CommandRequest[];
}

/**
 * How a chat's last run ended, as the chat list reports it. Not {@link RunStatus}: the list has no
 * business distinguishing `done` from `error`, and it must be able to say `paused` without claiming
 * the run is still streaming.
 */
export type ChatRunStatus = "idle" | "running" | "paused" | "cancelled";

/**
 * One saved conversation.
 *
 * The chat id *is* the runtime session id: the socket subscribes with it, and every frame names it.
 * That is what makes a chat resumable — the runtime keys the transcript, the phase statuses and the
 * usage counters by this id, so a switch both re-subscribes and re-reads the same session.
 *
 * `workspace` is the absolute project path the chat belongs to, or null for one started with no
 * folder open. The chat list's "This workspace" scope is exactly this field.
 */
export interface Chat {
  id: string;
  title: string;
  workspace: string | null;
  phase: Phase;
  providerId: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  runStatus: ChatRunStatus;
}

export interface ChatsResponse {
  chats: Chat[];
}

export interface ChatResponse {
  chat: Chat;
}

/** What "refresh this chat" fetches: the row's metadata and the runtime state behind it. */
export interface ChatStateResponse {
  chat: Chat;
  state: SessionState;
}

export interface CreateChatRequest {
  title?: string;
  workspace?: string;
  phase?: Phase;
}

/** A partial edit: every field omitted is left as it was. */
export interface ChatPatch {
  title?: string;
  phase?: Phase;
  providerId?: string | null;
  model?: string | null;
}

/**
 * One promptable skill, served by `GET /api/skills`.
 *
 * A skill is a markdown file the app only ever reads: the composer turns its body into a prompt, and
 * nothing here writes or executes one.
 */
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  source: "workspace" | "user";
  /** Absolute path of the markdown file, for the tooltip. */
  path: string;
}

export interface SkillsResponse {
  skills: SkillInfo[];
}

export interface SkillResponse {
  skill: SkillInfo;
  body: string;
}

/**
 * Measured by Orbital, not reported by the gateway: token counts from the provider proved
 * unreliable, so these count what was actually sent and received.
 */
export interface UsageSnapshot {
  modelCalls: number;
  toolCalls: number;
  promptChars: number;
  completionChars: number;
  /** High-water mark of a single prompt, in estimated tokens. */
  contextTokens: number;
  /** The window `contextTokens` is measured against; 0 when unknown. */
  contextWindow: number;
  runningMs: number;
}

/**
 * One capability the user may allow the agent, served by `GET /api/capabilities`.
 *
 * The backend owns the list, its wording and its per-mode defaults; the composer renders whatever
 * it returns, so adding or rewording a capability is a backend-only change.
 */
export interface CapabilityInfo {
  id: CapabilityId;
  label: string;
  /** One line saying what the agent may do once this is on. */
  description: string;
  /** Whether the capability is on in Plan before the user changes anything. */
  planDefault: boolean;
  /** Whether the capability is on in Build before the user changes anything. */
  buildDefault: boolean;
}

export interface CapabilitiesResponse {
  capabilities: CapabilityInfo[];
}

// ---------------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------------

export interface Envelope<T = unknown> {
  v: typeof PROTOCOL_VERSION;
  type: WsEventType;
  sessionId: string | null;
  /** Process-wide frame number: orders the whole server's output, not this session's. */
  seq: number;
  /**
   * This session's frame number. A client is only sent its own session's frames, so this is the
   * one a gap can be detected on — `seq` moves whenever another session is busy. Null when the
   * frame belongs to no session (`pong`, a socket-level error).
   */
  sessionSeq: number | null;
  /** Unix epoch milliseconds. */
  ts: number;
  payload: T;
}

export type WsEventType =
  | "session.state"
  | "phase.changed"
  | "agent.node"
  | "agent.message.start"
  | "agent.token"
  | "agent.message.end"
  | "agent.tool_call"
  | "agent.tool_result"
  | "agent.todos"
  | "agent.error"
  | "agent.done"
  | "terminal.output"
  | "terminal.exit"
  | "file.changed"
  | "artifact.updated"
  | "usage.updated"
  | "agent.command_request"
  | "approval.resolved"
  | "agent.answer.start"
  | "agent.answer.token"
  | "agent.answer.end"
  | "log"
  | "error"
  | "pong";

/** Server → client frame payloads. */
export interface ServerPayloads {
  "session.state": SessionState;
  "phase.changed": { phase: Phase; status: PhaseStatus };
  "agent.node": { node: string; agent: AgentId; phase: Phase | null };
  "agent.message.start": { messageId: string; agent: AgentId; phase: Phase | null };
  "agent.token": { messageId: string; text: string };
  "agent.message.end": { messageId: string; content: string };
  "agent.tool_call": ToolCall;
  "agent.tool_result": ToolResult;
  /** The agent's working list for this run, complete on every frame — never a delta. */
  "agent.todos": { items: TodoItem[] };
  "agent.error": { agent: AgentId; message: string; detail: string | null };
  "agent.done": { phase: Phase; status: RunStatus; summary: string };
  "terminal.output": { commandId: string; channel: "stdout" | "stderr"; data: string };
  "terminal.exit": CommandResult & { commandId: string };
  "file.changed": { path: string; kind: "created" | "modified" | "deleted" };
  "artifact.updated": { name: string; content: string };
  "usage.updated": UsageSnapshot;
  "agent.command_request": CommandRequest;
  "approval.resolved": { requestId: string; approved: boolean; remember: boolean };
  /**
   * A side question's answer, streamed separately from the transcript: the question was asked about
   * the turn in flight, not alongside it, so its answer must never become a chat message. Every
   * frame carries the `requestId` the client sent with `agent.ask`, which is what lets one answer
   * be told from another — and from the transcript itself.
   */
  "agent.answer.start": { requestId: string };
  "agent.answer.token": { requestId: string; text: string };
  /**
   * The last frame of an answer. `error` is non-null when the question failed or was cancelled,
   * which is why a failed side question never arrives as `agent.error` — this stream owns it, so
   * the answer pane reports its own failures and the run's error slot stays about the run.
   */
  "agent.answer.end": { requestId: string; content: string; error: string | null };
  log: { level: "debug" | "info" | "warn" | "error"; message: string };
  error: { message: string; detail: string | null };
  pong: { ts: number };
}

export type ServerMessage = {
  [K in WsEventType]: Envelope<ServerPayloads[K]> & { type: K };
}[WsEventType];

// ---------------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------------

export type ClientMessage =
  /**
   * The first frame of every connection: the runtime refuses a socket that does not present its
   * token within five seconds, and the transport sends this before anything the store asks for.
   * It is a frame rather than a query parameter because a query string is written to every access
   * log the socket passes through.
   */
  | { type: "auth"; token: string }
  | { type: "ping" }
  | { type: "subscribe"; sessionId: string }
  | {
      type: "agent.run";
      sessionId: string;
      phase: Phase;
      prompt: string;
      projectPath: string;
      /** When true the orchestrator chains into the next phase on success. */
      autoAdvance: boolean;
      /** Overrides the configured model for this run only. */
      model?: string;
      /**
       * Pins this run to one provider profile — its endpoint, its key and its model — instead of
       * the active one. The active profile is not moved: the pin is this run's choice.
       */
      providerId?: string;
      /** Workspace-relative paths to fold into the brief; null when nothing is attached. */
      attachments: string[] | null;
      /**
       * Null means "do not send the parameter": a gateway that does not know `reasoning_effort`
       * rejects the whole request, so an unset preference must stay off the wire.
       */
      reasoningEffort: ReasoningEffort | null;
      /**
       * Ids the user has enabled. Null means "no restriction" — the API caller that does not care
       * — which is not the same as an empty list, where the agent may use nothing.
       */
      capabilities: CapabilityId[] | null;
      /** Null and "ask" both keep the approval card on every command; "allow_all" runs them. */
      permission: PermissionMode | null;
    }
  | {
      /**
       * One conversational turn with a phase's specialist: no orchestrator, no verdict and no
       * artefact. The plan phase uses this so the user can agree the approach before a file exists.
       */
      type: "agent.chat";
      sessionId: string;
      phase: Phase;
      message: string;
      projectPath: string;
      model?: string;
      /** Pins this turn to one provider profile; see the `agent.run` frame. */
      providerId?: string;
      /** Workspace-relative paths to fold into the turn; null when nothing is attached. */
      attachments: string[] | null;
      /** Null means the parameter is left off the request entirely. */
      reasoningEffort: ReasoningEffort | null;
      /** Ids the user has enabled; null means "no restriction", not "nothing". */
      capabilities: CapabilityId[] | null;
      /** Null and "ask" both keep the approval card on every command; "allow_all" runs them. */
      permission: PermissionMode | null;
    }
  | { type: "agent.cancel"; sessionId: string }
  | {
      /**
       * Ask the run to stop at its next step boundary. Not a mid-token freeze: the frames already
       * streaming finish, the state is preserved, and `resume` continues from there.
       */
      type: "agent.pause";
      sessionId: string;
    }
  | { type: "agent.resume"; sessionId: string }
  | {
      /**
       * A side question about the turn in flight. Its answer streams back as `agent.answer.*`,
       * tagged with `requestId`, and is deliberately never appended to the transcript.
       */
      type: "agent.ask";
      sessionId: string;
      question: string;
      requestId: string;
    }
  | {
      /**
       * Stop one side answer. No sessionId: the question is identified by its own id, and it does
       * not touch the run — cancelling a question is not cancelling the work it asked about.
       */
      type: "agent.ask.cancel";
      requestId: string;
    }
  | {
      /**
       * The user's decision on a held command. `remember` allows every later command in this run,
       * so a build phase does not stop on every `npm install`.
       */
      type: "agent.approve";
      sessionId: string;
      requestId: string;
      approved: boolean;
      remember: boolean;
    }
  | {
      type: "terminal.exec";
      sessionId: string;
      commandId: string;
      command: string;
      cwd: string;
      timeout: number | null;
    }
  | { type: "terminal.cancel"; sessionId: string; commandId: string }
  | { type: "files.watch"; sessionId: string; root: string };

// ---------------------------------------------------------------------------------
// REST contract (mirrors the FastAPI routers, all under /api)
// ---------------------------------------------------------------------------------
/**
 * GET    /api/health                       -> HealthResponse
 * GET    /api/phases                       -> { phases: PhaseInfo[] }
 * GET    /api/project                      -> ProjectResponse
 * POST   /api/project/open                 <- { path }            -> ProjectResponse
 * GET    /api/projects                     -> ProjectsResponse
 * POST   /api/projects                     <- { parent, name, description, repository?, branchStrategy? } -> { project: ProjectEntry }
 * PATCH  /api/projects/{id}                <- ProjectPatch      -> ProjectsResponse
 * DELETE /api/projects/{id}                -> ProjectsResponse
 * GET    /api/branch-strategies            -> BranchStrategiesResponse
 * GET    /api/capabilities                -> CapabilitiesResponse
 * GET    /api/project/tree?depth=          -> { root: FileNode }  (recursive, depth-limited)
 * GET    /api/files/content?path=          -> FileContent
 * PUT    /api/files/content                <- { path, content }   -> FileContent
 * DELETE /api/files?path=                  -> { ok: boolean }
 * GET    /api/git/status                   -> GitStatus
 * POST   /api/git/commit                   <- { message, paths? } -> CommandResult
 * POST   /api/git/push                     <- { remote?, branch? }-> CommandResult
 * POST   /api/git/init                     <- { remote? }         -> CommandResult
 * POST   /api/terminal/exec                <- { command, cwd?, timeout? } -> CommandResult
 * POST   /api/agents/run                   <- RunAgentRequest    -> { sessionId, status }
 * POST   /api/agents/cancel                <- { sessionId }       -> { ok: boolean }
 * GET    /api/agents/session/{sessionId}   -> SessionState
 * GET    /api/sessions                     -> { sessions: SessionState[] }
 * GET    /api/config                       -> ConfigResponse     (never returns the API key)
 * PUT    /api/config                       <- ConfigUpdate       -> ConfigUpdateResponse
 * GET    /api/files/search?q=&limit=       -> SearchResponse
 * POST   /api/system/pick-folder           <- { title?, initialDir? } -> PickFolderResponse
 *
 * Chats. The chat id is the runtime session id, so a chat re-reads the run it belongs to:
 * GET    /api/chats?workspace=&all=        -> ChatsResponse        (newest first)
 * POST   /api/chats                        <- CreateChatRequest    -> ChatResponse
 * GET    /api/chats/{id}                   -> ChatStateResponse
 * PATCH  /api/chats/{id}                   <- ChatPatch            -> ChatResponse
 * DELETE /api/chats/{id}                   -> ChatsResponse
 * POST   /api/chats/{id}/clear             -> ChatStateResponse    (empties the transcript)
 *
 * Skills, read-only markdown prompts. A workspace skill id is unique only within its workspace, so
 * both routes take the workspace to read (`?workspace=`, defaulting to the open project):
 * GET    /api/skills?workspace=             -> SkillsResponse
 * GET    /api/skills/{id}?workspace=        -> SkillResponse
 *
 * Provider profiles, which decide what a run talks to. The client reads the model list off the
 * profile (`connect` stores it) rather than from `/api/models`, so the two always describe the
 * same endpoint:
 * GET    /api/providers                    -> ProvidersResponse
 * GET    /api/providers/presets            -> ProviderPresetsResponse
 * POST   /api/providers                    <- CreateProviderRequest -> ProvidersResponse
 * PATCH  /api/providers/{id}               <- UpdateProviderRequest -> ProvidersResponse
 * DELETE /api/providers/{id}               -> ProvidersResponse
 * POST   /api/providers/{id}/activate      -> ProvidersResponse
 * POST   /api/providers/{id}/connect       -> ProviderConnectResponse   (always HTTP 200)
 * GET    /api/providers/{id}/models        -> ProviderModelsResponse    (stored, no network)
 * POST   /api/providers/{id}/test          -> ProviderTestResponse
 */

export interface HealthResponse {
  status: "ok";
  version: string;
  protocolVersion: number;
  model: string;
  /** False when ORBITAL_LLM_API_KEY is unset — agents will refuse to run. */
  llmConfigured: boolean;
  /**
   * What the last authenticated gateway call revealed about the key. `unknown` until something
   * settles it; `rejected` means the key is present but the gateway refused it, which is the
   * state a presence check cannot see.
   */
  llmCredential: "unknown" | "ok" | "rejected";
  /** The gateway's own words when it refused, for the settings row. */
  llmCredentialDetail: string | null;
  /** Binaries the tool layer could not find on PATH. */
  missingBinaries: string[];
  uptimeSeconds: number;
}

export interface ProjectResponse {
  projectPath: string | null;
  name: string | null;
  /** True when the folder exists and is writable. */
  writable: boolean;
  git: GitStatus;
}

/**
 * A project the launcher knows about.
 *
 * This is registry metadata, not a live workspace: the directory may have been moved or deleted
 * since it was last opened, so nothing here proves the path still exists.
 */
export interface ProjectEntry {
  id: string;
  name: string;
  /** Absolute directory the project lives in. */
  path: string;
  description: string | null;
  /** Starred by the user; the launcher has a scope for these. */
  favourite: boolean;
  /** Unix epoch seconds. */
  createdAt: number;
  /**
   * Unix epoch seconds; the launcher orders by this, most recent first. `0` means the project has
   * been dropped from recents and has not been opened since.
   */
  lastOpenedAt: number;
  /** Git remote the agents push to, or null when the project is not tied to a repository. */
  repository: string | null;
  /**
   * Id of the branching strategy the agents follow; null exactly when {@link repository} is null.
   * Look the id up in `GET /api/branch-strategies` for its label and workflow.
   */
  branchStrategy: string | null;
}

/**
 * One branching model the agents can be told to follow.
 *
 * The backend owns the list; the UI renders whatever it returns, so adding a strategy is a
 * backend-only change.
 */
export interface BranchStrategyInfo {
  id: string;
  label: string;
  /** One line for the chooser, explaining when this model suits a project. */
  summary: string;
  /** The branches the model uses, e.g. `main` or `main, develop, feature/*`. */
  branches: string;
  /** The sentence handed to the agents, so it states the branch model concretely. */
  workflow: string;
}

export interface BranchStrategiesResponse {
  strategies: BranchStrategyInfo[];
}

/** A partial edit: every field omitted is left as it was. */
export interface ProjectPatch {
  name?: string;
  description?: string | null;
  favourite?: boolean;
  /** Forgets that the project was opened, which is what drops it out of the recent scopes. */
  clearRecent?: boolean;
  /**
   * The backend reads `""` here as "clear" — it detaches the project from its repository and drops
   * the strategy with it — while `null` or an omitted field leaves the pair alone.
   */
  repository?: string | null;
  /** Must accompany a repository: the backend refuses one without the other. */
  branchStrategy?: string | null;
}

export interface DocsResponse {
  markdown: string;
  /** Where the markdown came from, so the reader knows whether it is the repository's own docs. */
  source: string;
}

export interface ProjectsResponse {
  projects: ProjectEntry[];
}

export interface RunAgentRequest {
  sessionId: string;
  phase: Phase;
  prompt: string;
  projectPath: string;
  autoAdvance: boolean;
}

export interface ConfigResponse {
  model: string;
  baseUrl: string;
  apiKeyConfigured: boolean;
  commandTimeout: number;
  maxOutputBytes: number;
  allowedRoots: string[];
  /** The window the usage gauge measures against. */
  contextWindow: number;
  /** Output ceiling per specialist turn; 0 means unlimited. */
  maxTokens: number;
}

/** Fields the settings page may change. Anything omitted is left alone. */
export interface ConfigUpdate {
  model?: string;
  baseUrl?: string;
  /** Write-only: never read back, only ever reported as configured. */
  apiKey?: string;
  commandTimeout?: number;
  maxOutputBytes?: number;
  contextWindow?: number;
  maxTokens?: number;
  allowedRoots?: string[];
}

export interface ConfigUpdateResponse {
  config: ConfigResponse;
  /** Names of the fields that actually changed, for reporting back to the user. */
  changed: string[];
}

/** A shell command the agent wants to run, held until the user decides. */
export interface CommandRequest {
  /** The tool-call id, so the card pairs with the inspector row and the terminal stream. */
  id: string;
  agent: AgentId;
  phase: Phase;
  command: string;
  cwd: string;
  /** Why the agent wants it — the tool the model called, for context. */
  tool: string;
}

export interface SearchHit {
  /** Workspace-relative, POSIX-separated. */
  path: string;
  line: number;
  text: string;
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  /** True when the hit limit was reached and more matches exist. */
  truncated: boolean;
}

/** Result of the native folder chooser offered by the local runtime. */
export interface PickFolderResponse {
  /** Absolute path the user selected, or null when nothing was selected. */
  path: string | null;
  /** False when this runtime cannot show a dialog — the UI must offer a manual path instead. */
  available: boolean;
  /** Why `path` is null: a busy dialog, an unavailable picker, or a failure. Null on cancel. */
  reason: string | null;
}

/** Convenience: build a server envelope with the current protocol version. */
export function envelope<K extends WsEventType>(
  type: K,
  payload: ServerPayloads[K],
  opts: { sessionId?: string | null; seq: number },
): Envelope<ServerPayloads[K]> & { type: K } {
  return {
    v: PROTOCOL_VERSION,
    type,
    sessionId: opts.sessionId ?? null,
    seq: opts.seq,
    ts: Date.now(),
    payload,
  } as Envelope<ServerPayloads[K]> & { type: K };
}
