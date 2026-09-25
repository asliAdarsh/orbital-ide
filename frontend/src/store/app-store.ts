/**
 * Single Zustand store for the whole app.
 *
 * `applyEvent` is the only place WebSocket frames mutate state: the socket layer feeds
 * one frame, this file decides what it means. Components select single fields, never the
 * whole state, so a streaming token does not re-render the file tree.
 */

import { create } from "zustand";

import { api, errorMessage } from "@/lib/api";
import type { SocketStatus } from "@/lib/ws";
import {
  CAPABILITY_IDS,
  PHASES,
  isCapabilityId,
  isReasoningEffort,
  type AgentId,
  type CapabilityId,
  type CapabilityInfo,
  type ChatMessage,
  type CommandRequest,
  type CommandResult,
  type FileContent,
  type FileNode,
  type HealthResponse,
  type ModelInfo,
  type PermissionMode,
  type Phase,
  type PhaseStatus,
  type ProjectEntry,
  type ProjectPatch,
  type ProjectResponse,
  type ReasoningEffort,
  type ServerMessage,
  type SessionState,
  type TodoItem,
  type ToolCall,
  type ToolResult,
  type UsageSnapshot,
} from "@/types/protocol";

/** Long enough to scroll back through a build, short enough to render every frame. */
const TERMINAL_HISTORY_LIMIT = 50;
/** Tool calls the inspector keeps. */
const TOOL_HISTORY_LIMIT = 60;
const LOG_LIMIT = 400;
const AUTO_ADVANCE_KEY = "orbital.autoAdvance";
const MODEL_KEY = "orbital.model";
const REASONING_KEY = "orbital.reasoningEffort";
const PANELS_KEY = "orbital.panels";
const PERMISSION_KEY = "orbital.permission";
const CAPABILITIES_KEY = "orbital.capabilities";
/** Approval cards kept so a decided one stays visible long enough to read. */
const APPROVAL_HISTORY_LIMIT = 20;

let terminalCounter = 0;

function createTerminalTab(cwd: string): TerminalTab {
  terminalCounter += 1;
  return {
    id: `term-${terminalCounter}-${Date.now().toString(36)}`,
    title: `Terminal ${terminalCounter}`,
    cwd,
    transcript: [],
  };
}

/** Which of the three panels are shown. */
export type PanelName = "left" | "right" | "bottom";

export interface PanelVisibility {
  left: boolean;
  right: boolean;
  bottom: boolean;
}

const DEFAULT_PANELS: PanelVisibility = { left: true, right: true, bottom: true };

const EMPTY_USAGE: UsageSnapshot = {
  modelCalls: 0,
  toolCalls: 0,
  promptChars: 0,
  completionChars: 0,
  contextTokens: 0,
  contextWindow: 0,
  runningMs: 0,
};

/** A file open in the editor, with the content the editor is showing for it. */
export interface OpenFile {
  path: string;
  content: string;
  language: string;
  /** Edited here and not yet written back to disk. */
  dirty: boolean;
  /** The runtime clipped the file at its read limit, so saving would lose the tail. */
  truncated: boolean;
}

/** A diff the centre shows instead of the editor. */
export interface DiffView {
  path: string;
  original: string;
  modified: string;
}

/** One command in a terminal tab: the line, its stream, and how it ended. */
export interface TerminalEntry {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  output: string;
  /** Null while the command is still running. */
  result: CommandResult | null;
}

/** One shell tab, holding the transcript the panel replays on mount. */
export interface TerminalTab {
  id: string;
  title: string;
  cwd: string;
  transcript: TerminalEntry[];
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  ts: number;
}

/** A held command together with what the user decided about it; the chat renders both. */
export interface ApprovalCard extends CommandRequest {
  decided: "approved" | "denied" | null;
}

/** Read a preference, tolerating disabled storage. */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * A persisted effort can outlive the wire values — an older or hand-edited value would be refused
 * by the backend — so anything unrecognised degrades to "not set" rather than being sent.
 */
function readStoredReasoningEffort(): ReasoningEffort | "" {
  const stored = readStored(REASONING_KEY);
  return stored !== null && isReasoningEffort(stored) ? stored : "";
}

function readStoredFlag(key: string, fallback: boolean): boolean {
  const stored = readStored(key);
  return stored === null ? fallback : stored === "true";
}

/** Persist a preference; best-effort, the value still applies for this session. */
function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode).
  }
}

function readStoredPanels(): PanelVisibility {
  const stored = readStored(PANELS_KEY);
  if (stored === null) return DEFAULT_PANELS;
  try {
    const parsed = JSON.parse(stored) as Partial<PanelVisibility>;
    return {
      left: parsed.left !== false,
      right: parsed.right !== false,
      bottom: parsed.bottom !== false,
    };
  } catch {
    return DEFAULT_PANELS;
  }
}

/**
 * Read the stored approval setting. Anything unrecognised degrades to asking: a hand-edited value
 * must never be what turns every command loose.
 */
function readStoredPermission(): PermissionMode {
  return readStored(PERMISSION_KEY) === "allow_all" ? "allow_all" : "ask";
}

/** Every capability off; the catalogue's own defaults replace this the moment it loads. */
function emptyCapabilities(): Record<CapabilityId, boolean> {
  return CAPABILITY_IDS.reduce(
    (acc, id) => ({ ...acc, [id]: false }),
    {} as Record<CapabilityId, boolean>,
  );
}

function noOverrides(): Record<ComposerMode, Partial<Record<CapabilityId, boolean>>> {
  return { plan: {}, build: {} };
}

/**
 * A stored override can outlive the catalogue — an id may have been renamed or dropped — so only
 * known ids holding real booleans survive; anything else degrades to "no opinion" and the mode's
 * own default applies.
 */
function readStoredCapabilityOverrides(): Record<ComposerMode, Partial<Record<CapabilityId, boolean>>> {
  const stored = readStored(CAPABILITIES_KEY);
  if (stored === null) return noOverrides();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return noOverrides();
  }
  if (typeof parsed !== "object" || parsed === null) return noOverrides();
  const readMode = (mode: ComposerMode): Partial<Record<CapabilityId, boolean>> => {
    const bucket = (parsed as Record<string, unknown>)[mode];
    if (typeof bucket !== "object" || bucket === null) return {};
    const overrides: Partial<Record<CapabilityId, boolean>> = {};
    for (const [key, value] of Object.entries(bucket as Record<string, unknown>)) {
      if (isCapabilityId(key) && typeof value === "boolean") overrides[key] = value;
    }
    return overrides;
  };
  return { plan: readMode("plan"), build: readMode("build") };
}

function idlePhases(): Record<Phase, PhaseStatus> {
  return PHASES.reduce(
    (acc, phase) => ({ ...acc, [phase]: "idle" as PhaseStatus }),
    {} as Record<Phase, PhaseStatus>,
  );
}

/**
 * Which surface fills the window. The launcher is the entry point: the IDE needs a project, so
 * starting there and letting the user choose one is the only way to reach it deliberately.
 */
export type AppView = "dashboard" | "ide";

/**
 * The composer's two modes, in toggle order.
 *
 * The ids are what the store, the capability defaults and the frame all key off; the labels and
 * hints are the only place the difference is spelled out, and the composer and the config dialog
 * read the same copy so they cannot describe the modes differently.
 */
export const COMPOSER_MODES = [
  {
    id: "plan",
    label: "Plan",
    hint: "Plan — research and plan with the agent. It writes the plan and the mocks, and builds nothing.",
  },
  {
    id: "build",
    label: "Build",
    hint: "Build — the agent does this phase's work: it writes and changes the project.",
  },
] as const;

export type ComposerMode = (typeof COMPOSER_MODES)[number]["id"];

export interface AppState {
  backendBase: string | null;
  socketStatus: SocketStatus;
  health: HealthResponse | null;

  view: AppView;
  /** Projects the user has created or opened before, most recently opened first. */
  projects: ProjectEntry[];
  projectsLoading: boolean;
  projectsError: string | null;

  project: ProjectResponse | null;
  tree: FileNode | null;
  treeVersion: number;

  phaseStatus: Record<Phase, PhaseStatus>;
  activePhase: Phase;
  artifacts: Record<string, string>;
  /**
   * When false — the default — a run stops at the end of each phase and waits for approval
   * before the next one starts. True chains the whole pipeline in one go.
   */
  autoAdvance: boolean;
  /** Model id every run uses unless overridden. Empty = whatever the backend is configured with. */
  model: string;
  /**
   * Reasoning effort sent with each message. Empty = the parameter is left off the frame, because
   * a gateway that does not know `reasoning_effort` rejects the whole request.
   */
  reasoningEffort: ReasoningEffort | "";
  /** Models the gateway offers, for the composer's picker. */
  models: ModelInfo[];
  /** Which side the composer is on. The capability defaults and the frame both key off it. */
  composerMode: ComposerMode;
  /** The catalogue from `GET /api/capabilities`; empty until it has loaded. */
  capabilityCatalogue: CapabilityInfo[];
  /** True while the catalogue request is in flight, so two callers still fetch it once. */
  capabilitiesLoading: boolean;
  /** Why the catalogue could not be loaded; null once it has. */
  capabilitiesError: string | null;
  /** Which capabilities the user has enabled, by id. */
  capabilities: Record<CapabilityId, boolean>;
  /**
   * The user's explicit capability choices, per mode, persisted. A mode's defaults fill only the
   * ids the user has not touched, so switching modes never discards a deliberate change.
   */
  capabilityOverrides: Record<ComposerMode, Partial<Record<CapabilityId, boolean>>>;
  /**
   * How the agent treats a command it wants to run. `ask` keeps the approval card on every one;
   * `allow_all` runs them without asking. A session setting, not the card's per-run "allow all".
   */
  permission: PermissionMode;
  /**
   * The agent's working list for the current run, replaced wholesale by every `agent.todos` frame
   * and emptied when a run starts, so a stale list never outlives the run that published it.
   */
  todos: TodoItem[];
  /** Workspace-relative paths the composer attaches to the next message. */
  attachments: string[];
  /** What this session has consumed so far, as last reported by the backend. */
  usage: UsageSnapshot;
  /** Which of the three panels are expanded. Toggled from the nav. */
  panels: PanelVisibility;
  /** True while the settings page is open over the centre. */
  settingsOpen: boolean;

  messages: ChatMessage[];
  toolCalls: ToolCall[];
  toolResults: Record<string, ToolResult>;
  activeAgent: AgentId | null;
  running: boolean;
  runError: string | null;

  openFiles: OpenFile[];
  activeFilePath: string | null;
  diff: DiffView | null;

  terminals: TerminalTab[];
  activeTerminalId: string | null;
  /** Most recent in-flight command, for the tab strip's running indicator. */
  activeCommandId: string | null;
  /** Commands the agent is holding for a decision, newest first. */
  approvals: ApprovalCard[];

  logs: LogEntry[];

  setBackendBase(base: string): void;
  setSocketStatus(status: SocketStatus): void;
  setHealth(health: HealthResponse | null): void;
  setProject(project: ProjectResponse | null): void;
  setTree(tree: FileNode | null): void;
  setView(view: AppView): void;
  /**
   * Reload the launcher's list. The promise settles when the refresh has been applied, so a
   * caller that awaits it sees the new list; failures land in `projectsError` rather than
   * rejecting.
   */
  loadProjects(): Promise<void>;
  /**
   * Rename, re-describe, star or clear a project's recents history.
   *
   * Resolves once the refreshed list is in place, so a caller that closes a dialog on success
   * closes it after the row has actually changed.
   */
  patchProject(id: string, patch: ProjectPatch): Promise<void>;
  setActivePhase(phase: Phase): void;
  setAutoAdvance(enabled: boolean): void;
  setModel(model: string): void;
  /** Persisted like the model preference; `""` means the parameter is never sent. */
  setReasoningEffort(effort: ReasoningEffort | ""): void;
  setModels(models: ModelInfo[]): void;
  /** Fetch the capability catalogue once and cache it in the store; failures land in state. */
  loadCapabilities(): void;
  /**
   * Switch the composer to `mode` and apply its defaults, keeping the user's explicit choices for
   * that mode. Called whenever the mode changes.
   */
  applyCapabilityDefaults(mode: ComposerMode): void;
  /** Turn one capability on or off, remembering the choice for the mode in force. */
  setCapability(id: CapabilityId, on: boolean): void;
  /** Forget the user's choices for `mode` and restore what the catalogue starts it with. */
  resetCapabilityDefaults(mode: ComposerMode): void;
  /** Persisted like the other composer preferences; switching back to `ask` restores the cards. */
  setPermission(permission: PermissionMode): void;
  /** Tick a workspace file or folder for the next message. Picking the same path twice is a no-op. */
  attachContext(path: string): void;
  detachContext(path: string): void;
  /** Drop every pending pick, once a message has taken them. */
  clearContext(): void;
  setUsage(usage: UsageSnapshot): void;
  /** Flip one panel open or closed; the centre always stays visible. */
  togglePanel(panel: PanelName): void;
  setSettingsOpen(open: boolean): void;
  setArtifact(name: string, content: string): void;
  applySession(state: SessionState): void;
  applyEvent(message: ServerMessage): void;
  openFile(file: FileContent): void;
  closeFile(path: string): void;
  setActiveFilePath(path: string | null): void;
  editFile(path: string, content: string): void;
  saveActive(): Promise<void>;
  setDiff(diff: DiffView | null): void;
  addUserMessage(content: string, phase: Phase): void;
  startRun(): void;
  endRun(error?: string | null): void;
  /** Create a shell and focus it. Returns the new terminal's id. */
  addTerminal(cwd?: string): string;
  closeTerminal(id: string): void;
  setActiveTerminal(id: string): void;
  addTerminalEntry(tabId: string, entry: TerminalEntry): void;
  finishTerminalEntry(id: string, result: CommandResult): void;
  appendTerminalOutput(id: string, channel: "stdout" | "stderr", data: string): void;
  noteCommandRequest(request: CommandRequest): void;
  noteApprovalDecision(requestId: string, approved: boolean): void;
  pushLog(level: LogLevel, message: string): void;
  resetRun(): void;
}

/** Apply an update to one entry, in whichever terminal owns it. */
function withTabEntry(
  state: AppState,
  commandId: string,
  update: (entry: TerminalEntry) => TerminalEntry,
): Partial<AppState> {
  const index = state.terminals.findIndex((tab) =>
    tab.transcript.some((entry) => entry.id === commandId),
  );
  if (index === -1) return {};
  const tab = state.terminals[index];
  const terminals = state.terminals.slice();
  terminals[index] = {
    ...tab,
    transcript: tab.transcript.map((entry) => (entry.id === commandId ? update(entry) : entry)),
  };
  return { terminals };
}

/** Map a server frame onto a state patch. Pure, so the reducer is easy to reason about. */
function reduceEvent(state: AppState, message: ServerMessage): Partial<AppState> {
  switch (message.type) {
    case "session.state":
      return {
        phaseStatus: message.payload.phases,
        activePhase: message.payload.activePhase,
        // The state frame is the resync point: a held command that arrived while this socket was
        // reconnecting is recovered here, and decisions already made stay visible.
        approvals: [
          ...message.payload.pendingCommands.map((request) => ({ ...request, decided: null })),
          ...state.approvals.filter((card) => card.decided !== null),
        ].slice(0, APPROVAL_HISTORY_LIMIT),
        artifacts: message.payload.artifacts,
        messages: message.payload.messages,
        running: message.payload.status === "running",
        runError: message.payload.error,
        usage: message.payload.usage,
      };

    case "usage.updated":
      return { usage: message.payload };

    case "phase.changed":
      return {
        phaseStatus: { ...state.phaseStatus, [message.payload.phase]: message.payload.status },
      };

    case "agent.node":
      return { activeAgent: message.payload.agent };

    case "agent.message.start": {
      const entry: ChatMessage = {
        id: message.payload.messageId,
        role: "assistant",
        agent: message.payload.agent,
        content: "",
        phase: message.payload.phase ?? state.activePhase,
        createdAt: message.ts,
        streaming: true,
        toolCalls: [],
      };
      return { messages: [...state.messages, entry], activeAgent: message.payload.agent };
    }

    case "agent.token": {
      const index = state.messages.findIndex((entry) => entry.id === message.payload.messageId);
      if (index === -1) return {};
      const messages = state.messages.slice();
      messages[index] = { ...messages[index], content: messages[index].content + message.payload.text };
      return { messages };
    }

    case "agent.message.end": {
      const index = state.messages.findIndex((entry) => entry.id === message.payload.messageId);
      if (index === -1) return {};
      const messages = state.messages.slice();
      messages[index] = {
        ...messages[index],
        content: message.payload.content,
        streaming: false,
      };
      return { messages };
    }

    case "agent.tool_call":
      return { toolCalls: [message.payload, ...state.toolCalls].slice(0, TOOL_HISTORY_LIMIT) };

    case "agent.todos":
      // Wholesale replacement: each call publishes the full list, not a delta against the last.
      return { todos: message.payload.items };

    case "agent.tool_result": {
      const result = message.payload;
      const toolResults = { ...state.toolResults, [result.id]: result };
      // Settle the terminal row that streamed this command. `exitCode` stays null because the
      // tool contract reports success, not a process exit code.
      const settled = withTabEntry(state, result.id, (entry) => ({
        ...entry,
        result: {
          command: entry.command,
          cwd: entry.cwd,
          exitCode: null,
          stdout: result.output,
          stderr: result.error ?? "",
          durationMs: result.durationMs,
          truncated: result.truncated,
          timedOut: false,
          cancelled: false,
          error: result.error,
        },
      }));
      return { toolResults, ...settled };
    }

    case "agent.error":
      return { runError: message.payload.message, running: false };

    case "agent.done":
      return {
        running: false,
        runError: message.payload.status === "error" ? message.payload.summary : state.runError,
      };

    case "agent.command_request": {
      const card: ApprovalCard = { ...message.payload, decided: null };
      return {
        approvals: [card, ...state.approvals.filter((existing) => existing.id !== card.id)].slice(
          0,
          APPROVAL_HISTORY_LIMIT,
        ),
      };
    }

    case "approval.resolved":
      return {
        approvals: state.approvals.map((card) =>
          card.id === message.payload.requestId
            ? { ...card, decided: message.payload.approved ? "approved" : "denied" }
            : card,
        ),
      };

    case "terminal.output": {
      const { commandId, data } = message.payload;
      const owned = withTabEntry(state, commandId, (entry) => ({
        ...entry,
        output: entry.output + data,
      }));
      if (owned.terminals) return owned;
      // Output for a command the agent ran: open a row under the tool-call id in the active
      // terminal, so the stream sits beside the inspector's structured result.
      const call = state.toolCalls.find((entry) => entry.id === commandId);
      const tab = state.terminals.find((entry) => entry.id === state.activeTerminalId) ?? state.terminals[0];
      if (!call || !tab) return {};
      const entry: TerminalEntry = {
        id: commandId,
        command: typeof call.args.command === "string" ? call.args.command : call.name,
        cwd: typeof call.args.cwd === "string" ? call.args.cwd : tab.cwd,
        startedAt: call.startedAt,
        output: data,
        result: null,
      };
      return {
        terminals: state.terminals.map((candidate) =>
          candidate.id === tab.id
            ? { ...candidate, transcript: [...candidate.transcript, entry].slice(-TERMINAL_HISTORY_LIMIT) }
            : candidate,
        ),
      };
    }

    case "terminal.exit": {
      const { commandId, ...result } = message.payload;
      const settled = withTabEntry(state, commandId, (entry) => ({
        ...entry,
        result: result as CommandResult,
      }));
      return {
        ...settled,
        activeCommandId: commandId === state.activeCommandId ? null : state.activeCommandId,
      };
    }

    case "file.changed":
      return { treeVersion: state.treeVersion + 1 };

    case "artifact.updated":
      return { artifacts: { ...state.artifacts, [message.payload.name]: message.payload.content } };

    case "log":
      return {
        logs: [...state.logs, { level: message.payload.level, message: message.payload.message, ts: message.ts }].slice(
          -LOG_LIMIT,
        ),
      };

    case "error":
      return { runError: message.payload.message };

    case "pong":
      return {};

    default:
      return {};
  }
}

export const useAppStore = create<AppState>()((set, get) => {
  // One shell exists from the start; the panel can add more.
  const firstTerminal = createTerminalTab("");
  return {
    backendBase: null,
  socketStatus: "closed",
  health: null,

  view: "dashboard",
  projects: [],
  projectsLoading: false,
  projectsError: null,

  project: null,
  tree: null,
  treeVersion: 0,

  phaseStatus: idlePhases(),
  activePhase: "plan",
  artifacts: {},
  autoAdvance: readStoredFlag(AUTO_ADVANCE_KEY, false),
  model: readStored(MODEL_KEY) ?? "",
  reasoningEffort: readStoredReasoningEffort(),
  models: [],
  // Plan until the phase says otherwise: the composer's default mode is the one the plan phase
  // uses, and AgentChat re-defaults it from the phase the moment it mounts.
  composerMode: "plan",
  capabilityCatalogue: [],
  capabilitiesLoading: false,
  capabilitiesError: null,
  capabilities: emptyCapabilities(),
  capabilityOverrides: readStoredCapabilityOverrides(),
  permission: readStoredPermission(),
  todos: [],
  attachments: [],
  usage: EMPTY_USAGE,
  panels: readStoredPanels(),
  settingsOpen: false,

  messages: [],
  toolCalls: [],
  toolResults: {},
  activeAgent: null,
  running: false,
  runError: null,

  openFiles: [],
  activeFilePath: null,
  diff: null,

  terminals: [firstTerminal],
  activeTerminalId: firstTerminal.id,
  activeCommandId: null,
  approvals: [],

  logs: [],

  setBackendBase: (base) => set({ backendBase: base }),
  setSocketStatus: (socketStatus) => set({ socketStatus }),
  setHealth: (health) => set({ health }),
  // Opening a project is what moves the app into the IDE: every path that binds a workspace
  // (the launcher, a folder picked from the File menu, a session restore) goes through here.
  setProject: (project) => set({ project, view: project?.projectPath ? "ide" : "dashboard" }),

  setView: (view) => set({ view }),

  loadProjects: () => {
    set({ projectsLoading: true, projectsError: null });
    return api
      .listProjects()
      .then((projects) => set({ projects, projectsLoading: false }))
      .catch((cause: unknown) => {
        set({ projectsLoading: false, projectsError: errorMessage(cause) });
      });
  },

  patchProject: (id, patch) =>
    api
      .updateProject(id, patch)
      .then((projects) => {
        set({ projects, projectsError: null });
      })
      .catch((cause: unknown) => {
        set({ projectsError: errorMessage(cause) });
        throw cause;
      }),
  setTree: (tree) => set({ tree }),
  setActivePhase: (activePhase) => set({ activePhase }),

  setAutoAdvance: (enabled) => {
    writeStored(AUTO_ADVANCE_KEY, String(enabled));
    set({ autoAdvance: enabled });
  },

  setModel: (model) => {
    writeStored(MODEL_KEY, model);
    set({ model });
  },

  setReasoningEffort: (effort) => {
    writeStored(REASONING_KEY, effort);
    set({ reasoningEffort: effort });
  },

  setModels: (models) => set({ models }),

  loadCapabilities: () => {
    // Cached in state, so a second mount is free; a failure leaves the catalogue empty and the
    // next caller retries, which is what a dialog reopened after a bad start wants.
    if (get().capabilitiesLoading || get().capabilityCatalogue.length > 0) return;
    set({ capabilitiesLoading: true });
    void api
      .capabilities()
      .then((capabilityCatalogue) => {
        set({ capabilityCatalogue, capabilitiesError: null, capabilitiesLoading: false });
        get().applyCapabilityDefaults(get().composerMode);
      })
      .catch((cause: unknown) => {
        set({ capabilitiesError: errorMessage(cause), capabilitiesLoading: false });
      });
  },

  applyCapabilityDefaults: (mode) => {
    const { capabilityCatalogue, capabilityOverrides } = get();
    const overrides = capabilityOverrides[mode];
    const capabilities = { ...get().capabilities };
    for (const info of capabilityCatalogue) {
      capabilities[info.id] =
        overrides[info.id] ?? (mode === "plan" ? info.planDefault : info.buildDefault);
    }
    set({ composerMode: mode, capabilities });
  },

  setCapability: (id, on) => {
    const mode = get().composerMode;
    const capabilityOverrides = {
      ...get().capabilityOverrides,
      [mode]: { ...get().capabilityOverrides[mode], [id]: on },
    };
    writeStored(CAPABILITIES_KEY, JSON.stringify(capabilityOverrides));
    set((state) => ({ capabilities: { ...state.capabilities, [id]: on }, capabilityOverrides }));
  },

  resetCapabilityDefaults: (mode) => {
    const capabilityOverrides = { ...get().capabilityOverrides, [mode]: {} };
    writeStored(CAPABILITIES_KEY, JSON.stringify(capabilityOverrides));
    set({ capabilityOverrides });
    get().applyCapabilityDefaults(mode);
  },

  setPermission: (permission) => {
    writeStored(PERMISSION_KEY, permission);
    set({ permission });
  },

  attachContext: (path) =>
    set((state) =>
      state.attachments.includes(path) ? {} : { attachments: [...state.attachments, path] },
    ),

  detachContext: (path) =>
    set((state) => ({ attachments: state.attachments.filter((entry) => entry !== path) })),

  clearContext: () => set({ attachments: [] }),

  setUsage: (usage) => set({ usage }),

  togglePanel: (panel) =>
    set((state) => {
      const panels = { ...state.panels, [panel]: !state.panels[panel] };
      writeStored(PANELS_KEY, JSON.stringify(panels));
      return { panels };
    }),

  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setArtifact: (name, content) => set((state) => ({ artifacts: { ...state.artifacts, [name]: content } })),

  applySession: (session) =>
    set({
      phaseStatus: session.phases,
      activePhase: session.activePhase,
      artifacts: session.artifacts,
      messages: session.messages,
      running: session.status === "running",
      runError: session.error,
      usage: session.usage,
    }),

  applyEvent: (message) => set((state) => reduceEvent(state, message)),

  openFile: (file) =>
    set((state) => {
      const existing = state.openFiles.find((entry) => entry.path === file.path);
      if (existing) {
        const openFiles = state.openFiles.map((entry) =>
          entry.path === file.path
            ? { ...entry, content: file.content, truncated: file.truncated, dirty: false }
            : entry,
        );
        return { openFiles, activeFilePath: file.path, diff: null };
      }
      const openFiles = [
        ...state.openFiles,
        {
          path: file.path,
          content: file.content,
          language: file.language,
          dirty: false,
          truncated: file.truncated,
        },
      ];
      return { openFiles, activeFilePath: file.path, diff: null };
    }),

  closeFile: (path) =>
    set((state) => {
      const openFiles = state.openFiles.filter((entry) => entry.path !== path);
      const activeFilePath =
        state.activeFilePath === path ? (openFiles[openFiles.length - 1]?.path ?? null) : state.activeFilePath;
      return { openFiles, activeFilePath };
    }),

  setActiveFilePath: (path) => set({ activeFilePath: path, diff: null }),

  editFile: (path, content) =>
    set((state) => ({
      openFiles: state.openFiles.map((entry) =>
        entry.path === path ? { ...entry, content, dirty: true } : entry,
      ),
    })),

  saveActive: async () => {
    const path = get().activeFilePath;
    if (!path) return;
    const file = get().openFiles.find((entry) => entry.path === path);
    if (!file || !file.dirty) return;
    await api.writeFile(path, file.content);
    set((state) => ({
      openFiles: state.openFiles.map((entry) => (entry.path === path ? { ...entry, dirty: false } : entry)),
    }));
    get().pushLog("info", `saved ${path}`);
  },

  setDiff: (diff) => set({ diff }),

  addUserMessage: (content, phase) =>
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: `user-${Date.now()}-${state.messages.length}`,
          role: "user",
          agent: "orchestrator",
          content,
          phase,
          createdAt: Date.now(),
          streaming: false,
          toolCalls: [],
        },
      ],
    })),

  startRun: () => set({ running: true, runError: null, todos: [] }),
  endRun: (error = null) => set({ running: false, runError: error }),
  resetRun: () =>
    set({
      messages: [],
      toolCalls: [],
      toolResults: {},
      runError: null,
      running: false,
      activeAgent: null,
      todos: [],
    }),

  addTerminal: (cwd = "") => {
    const tab = createTerminalTab(cwd);
    set((state) => ({ terminals: [...state.terminals, tab], activeTerminalId: tab.id }));
    return tab.id;
  },

  closeTerminal: (id) =>
    set((state) => {
      const index = state.terminals.findIndex((tab) => tab.id === id);
      if (index === -1) return {};
      const terminals = state.terminals.filter((tab) => tab.id !== id);
      // Focus a neighbour rather than leaving the panel with nothing selected.
      const activeTerminalId =
        state.activeTerminalId === id
          ? (terminals[index] ?? terminals[index - 1] ?? terminals[0])?.id ?? null
          : state.activeTerminalId;
      return { terminals, activeTerminalId };
    }),

  setActiveTerminal: (activeTerminalId) => set({ activeTerminalId }),

  addTerminalEntry: (tabId, entry) =>
    set((state) => ({
      terminals: state.terminals.map((tab) =>
        tab.id === tabId
          ? { ...tab, transcript: [...tab.transcript, entry].slice(-TERMINAL_HISTORY_LIMIT) }
          : tab,
      ),
      activeCommandId: entry.id,
    })),

  finishTerminalEntry: (id, result) =>
    set((state) => ({
      ...withTabEntry(state, id, (entry) => ({ ...entry, result })),
      activeCommandId: state.activeCommandId === id ? null : state.activeCommandId,
    })),

  appendTerminalOutput: (id, _channel, data) =>
    set((state) => withTabEntry(state, id, (entry) => ({ ...entry, output: entry.output + data }))),

  noteCommandRequest: (request) =>
    set((state) => ({
      approvals: [{ ...request, decided: null }, ...state.approvals.filter((c) => c.id !== request.id)].slice(
        0,
        APPROVAL_HISTORY_LIMIT,
      ),
    })),

  noteApprovalDecision: (requestId, approved) =>
    set((state) => ({
      approvals: state.approvals.map((card) =>
        card.id === requestId ? { ...card, decided: approved ? "approved" : "denied" } : card,
      ),
    })),


  pushLog: (level, message) =>
    set((state) => ({ logs: [...state.logs, { level, message, ts: Date.now() }].slice(-LOG_LIMIT) })),
  };
});
