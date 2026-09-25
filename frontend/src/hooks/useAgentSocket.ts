/**
 * The single WebSocket bridge between the UI and the Python agent runtime.
 *
 * Three separate panels need to talk to the backend (the phase runner, the chat
 * composer, the terminal), so the socket is a module-level singleton: every caller of
 * this hook shares one connection, one session and one event feed. The hook itself is
 * cheap — it only reads the reactive connection status from the store.
 */

import { useEffect, useMemo } from "react";

import { api } from "@/lib/api";
import { createId } from "@/lib/utils";
import { OrbitalSocket, type SocketStatus } from "@/lib/ws";
import { useAppStore } from "@/store/app-store";
import { toast } from "@/components/common/Toaster";
import { CAPABILITY_IDS, type CapabilityId, type Phase } from "@/types/protocol";

const SESSION_KEY = "orbital.sessionId";

/**
 * Session identity is persisted so a window reload re-attaches to the run already in
 * progress instead of silently starting a second one.
 */
function resolveSessionId(): string {
  try {
    const existing = window.localStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const created = createId("session");
    window.localStorage.setItem(SESSION_KEY, created);
    return created;
  } catch {
    // Private-mode / disabled storage: an ephemeral id still works for this window.
    return createId("session");
  }
}

export const SESSION_ID = resolveSessionId();

export interface AgentSocketApi {
  status: SocketStatus;
  sessionId: string;
  /** Start a phase run. `autoAdvance` defaults to the user's pipeline preference. */
  run(phase: Phase, prompt: string, projectPath: string, autoAdvance?: boolean): void;
  /**
   * One conversational turn with a phase's specialist — no orchestrator, no verdict and no
   * artefact. The plan phase uses this so the approach can be agreed before a file exists.
   */
  chat(phase: Phase, message: string, projectPath: string): void;
  /** Cancel the in-flight agent run. */
  cancel(): void;
  /**
   * Answer a held command. `remember` allows every later command in this run, so a build phase
   * does not stop on each one.
   */
  approve(requestId: string, approved: boolean, remember: boolean): void;
  /** Run a shell command and return the terminal row id it streamed into. */
  exec(command: string, cwd?: string): string;
  /** Stop a command started by {@link AgentSocketApi.exec}. */
  cancelExec(commandId?: string): void;
  /** Subscribe to filesystem changes under `root`. */
  watch(root: string): void;
  /** Re-read the whole session from the REST API after a reconnect. */
  refreshSession(): Promise<void>;
}

let socket: OrbitalSocket | null = null;
let socketBase: string | null = null;

function ensureSocket(base: string): OrbitalSocket {
  if (socket && socketBase === base) return socket;
  socket?.close();
  socketBase = base;
  const store = () => useAppStore.getState();
  const created = new OrbitalSocket(base, {
    onMessage: (message) => store().applyEvent(message),
    onStatus: (status) => {
      store().setSocketStatus(status);
      // Registration is per connection, so a reconnect must re-subscribe.
      if (status === "open") created.subscribe(SESSION_ID);
    },
    // A dropped frame is worth showing, not just logging: these are the notices a *user action*
    // produces — a run started while the socket is reconnecting, a command typed into a dead
    // terminal — and the log panel is not where someone looks after pressing a button.
    onNotice: (level, message) => {
      store().pushLog(level, message);
      if (level === "warn") toast.warning(message);
    },
  });
  socket = created;
  created.connect();
  return created;
}

/**
 * The capability ids a frame carries.
 *
 * Null — not an empty list — until the catalogue has loaded: the user has not chosen anything yet,
 * and null is the wire's "no restriction". Once it has, the explicit list is what the config dialog
 * shows, and an empty list genuinely means everything is off.
 */
function enabledCapabilities(): CapabilityId[] | null {
  const store = useAppStore.getState();
  if (store.capabilityCatalogue.length === 0) return null;
  return CAPABILITY_IDS.filter((id) => store.capabilities[id]);
}

function runPhase(phase: Phase, prompt: string, projectPath: string, autoAdvance?: boolean): void {
  const store = useAppStore.getState();
  if (!socket) {
    store.pushLog("error", "Cannot start a run: the agent runtime is not connected.");
    return;
  }
  store.addUserMessage(prompt, phase);
  store.startRun();
  socket.runAgent({
    sessionId: SESSION_ID,
    phase,
    prompt,
    projectPath,
    // Omitted by callers that just want "run this phase"; the preference decides whether the
    // pipeline then continues on its own.
    autoAdvance: autoAdvance ?? store.autoAdvance,
    // Empty means "whatever the backend is configured with".
    model: store.model || undefined,
    // The picks are read here rather than passed in: the frame and the composer's pending chips
    // must describe the same set, and the composer clears them the moment this call returns.
    attachments: store.attachments.length > 0 ? store.attachments : null,
    // Null — not an empty string — is what keeps the parameter off the request entirely.
    reasoningEffort: store.reasoningEffort || null,
    capabilities: enabledCapabilities(),
    permission: store.permission,
  });
}

function chatTurn(phase: Phase, message: string, projectPath: string): void {
  const store = useAppStore.getState();
  if (!socket) {
    store.pushLog("error", "Cannot send: the agent runtime is not connected.");
    return;
  }
  store.addUserMessage(message, phase);
  store.startRun();
  socket.send({
    type: "agent.chat",
    sessionId: SESSION_ID,
    phase,
    message,
    projectPath,
    model: store.model || undefined,
    attachments: store.attachments.length > 0 ? store.attachments : null,
    reasoningEffort: store.reasoningEffort || null,
    capabilities: enabledCapabilities(),
    permission: store.permission,
  });
}

function cancelRun(): void {
  socket?.cancelAgent(SESSION_ID);
}

function execCommand(command: string, cwd?: string): string {
  const store = useAppStore.getState();
  const commandId = createId("cmd");
  const target = cwd ?? store.project?.projectPath ?? ".";
  // Commands run in whichever shell the user is looking at, created on demand.
  const tabId = store.activeTerminalId ?? store.addTerminal(target);
  store.addTerminalEntry(tabId, {
    id: commandId,
    command,
    cwd: target,
    startedAt: Date.now(),
    output: "",
    result: null,
  });
  socket?.exec(SESSION_ID, commandId, command, target, null);
  return commandId;
}

function approveCommand(requestId: string, approved: boolean, remember: boolean): void {
  if (!socket) {
    useAppStore.getState().pushLog("error", "Cannot answer: the agent runtime is not connected.");
    return;
  }
  socket.send({ type: "agent.approve", sessionId: SESSION_ID, requestId, approved, remember });
}

function cancelCommand(commandId?: string): void {
  const target = commandId ?? useAppStore.getState().activeCommandId;
  if (!target) return;
  socket?.send({ type: "terminal.cancel", sessionId: SESSION_ID, commandId: target });
}

function watchWorkspace(root: string): void {
  socket?.watch(SESSION_ID, root);
}

async function refreshSession(): Promise<void> {
  useAppStore.getState().applySession(await api.session(SESSION_ID));
}

/** Module-level so the function identities — and therefore effect dependencies — are stable. */
const ACTIONS = {
  sessionId: SESSION_ID,
  run: runPhase,
  chat: chatTurn,
  cancel: cancelRun,
  approve: approveCommand,
  exec: execCommand,
  cancelExec: cancelCommand,
  watch: watchWorkspace,
  refreshSession,
} as const;

export function useAgentSocket(): AgentSocketApi {
  const status = useAppStore((state) => state.socketStatus);
  const base = useAppStore((state) => state.backendBase);

  useEffect(() => {
    if (base) ensureSocket(base);
  }, [base]);

  return useMemo(() => ({ ...ACTIONS, status }), [status]);
}
