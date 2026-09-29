/**
 * The single WebSocket bridge between the UI and the Python agent runtime.
 *
 * Three separate panels need to talk to the backend (the phase runner, the chat
 * composer, the terminal), so the socket is a module-level singleton: every caller of
 * this hook shares one connection, one session and one event feed. The hook itself is
 * cheap — it only reads the reactive connection status from the store.
 *
 * Its life belongs to the account, not to the window. Nothing here opens or closes it on
 * mount: `App` watches the signed-in uid and calls {@link openAgentSession} or
 * {@link endAgentSession}, so a sign-out stops the run, drops the connection and clears the
 * store even though the shell that uses this hook is unmounted at that moment.
 */

import { useMemo } from "react";

import { api, errorMessage } from "@/lib/api";
import { createId } from "@/lib/utils";
import { OrbitalSocket, type SocketStatus } from "@/lib/ws";
import { useAppStore } from "@/store/app-store";
import { toast } from "@/components/common/Toaster";
import { CAPABILITY_IDS, type CapabilityId, type Phase } from "@/types/protocol";

const SESSION_KEY = "orbital.sessionId";

/**
 * The id every frame carries: the chat this window is on, so the backend's run belongs to the chat
 * the user has open.
 *
 * The chat id *is* the runtime session id. That is what makes switching chats a session switch —
 * the socket re-subscribes to the new id and the runtime replays that chat's transcript, phase
 * statuses and usage — and it is why this is no longer the signed-in `uid`: one account has many
 * chats, and a uid names the account, not a conversation.
 *
 * A label, not a credential. What the runtime lets a socket or a request see is decided by the
 * runtime token it presents — the id only names which conversation the frame is about, and turning
 * it into an authorisation check would be trusting the client to police itself.
 *
 * With no chat — signed out, or a signed-in window that has not chosen one yet — the persisted
 * local id is used instead, which is the backend's cue to create the chat on the fly.
 *
 * A function rather than a constant: the active chat changes at runtime, and a snapshot taken at
 * import time would pin every later frame to the first chat.
 */
export function currentSessionId(): string {
  return useAppStore.getState().activeChatId ?? localSessionId();
}

/**
 * Session identity is persisted so a window reload re-attaches to the run already in
 * progress instead of silently starting a second one.
 */
function localSessionId(): string {
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
  /**
   * Load a chat, adopt it as this window's session and re-subscribe the socket to its id.
   *
   * The REST read is the point: the server owns the transcript, so switching away and back is what
   * restores a chat exactly as it was rather than trusting whatever this window still held.
   */
  openChat(id: string): Promise<void>;
  /** Stop the run at its next step boundary. Frames already streaming finish; the state is kept. */
  pause(): void;
  /** Continue a paused run from where it stopped. */
  resume(): void;
  /**
   * Ask a side question about the run in flight. The answer streams as its own thing, outside the
   * transcript. Returns the request id it will arrive under, or null when nothing was sent.
   */
  ask(question: string): string | null;
  /** Stop one side answer. The run it asked about carries on. */
  cancelAsk(requestId: string): void;
}

let socket: OrbitalSocket | null = null;
let socketBase: string | null = null;
/** The account the live socket was opened for; null while nothing is bound. */
let socketUid: string | null = null;
/**
 * The session this client is subscribed to — the only one whose frames may reach the store.
 *
 * Kept beside the socket because the reducer applies whatever it is handed: a frame already on the
 * wire when the subscription moves would otherwise be read as the current session's.
 */
let subscribedSession: string | null = null;

/**
 * Open the bridge for `uid`, and leave it open.
 *
 * `uid` is passed in rather than read from the auth SDK because the caller is the effect that
 * watches the uid: a socket is opened for the account that effect just reconciled, never for one
 * that has already been replaced. Idempotent for the same account and origin, so a caller whose
 * effect re-runs cannot end up with two sockets or two subscriptions.
 */
export function openAgentSession(base: string, uid: string): void {
  const existing = socket;
  if (existing !== null && socketBase === base && socketUid === uid) return;
  if (existing !== null) {
    // A different account is a switch, not a reconnect: its run is cancelled and its state cleared
    // exactly as a sign-out does, so nothing of the previous account can render for the new one. A
    // change of origin alone — the runtime coming back on another port — closes the dead bridge
    // instead; it is the same account's session, and the next subscribe re-replays it.
    if (socketUid !== uid) endAgentSession();
    else existing.close();
  }
  const store = () => useAppStore.getState();
  const created = new OrbitalSocket(base, {
    onMessage: (message) => {
      // Only the subscribed session's frames are ours to apply. A frame that names another one —
      // one queued for the account signed in a moment ago, say — is dropped rather than rendered.
      // The id is a label, not a permission: what the runtime lets a socket see is decided by the
      // token it presented in `auth`, never by the session id it asks for.
      if (message.sessionId !== null && message.sessionId !== subscribedSession) return;
      store().applyEvent(message);
      // A finished run is when a chat's row has changed on the server — its title is taken from the
      // first message, and its age and count move — so the list is re-read here rather than polled.
      if (message.type === "agent.done") void store().loadChats({ quiet: true });
    },
    onStatus: (status) => {
      store().setSocketStatus(status);
      if (status !== "open") return;
      // Registration is per connection, so every open re-subscribes. The id is read *now* rather
      // than remembered from when the socket was created, so a reconnect subscribes to the chat in
      // force rather than the one that opened the socket.
      const sessionId = currentSessionId();
      subscribedSession = sessionId;
      created.subscribe(sessionId);
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
  socketBase = base;
  socketUid = uid;
  subscribedSession = null;
  created.connect();
}

/**
 * Take the session down: stop the run it has in flight, close the socket, and clear what the
 * socket put in the store.
 *
 * This is what a sign-out is missing without it. The socket is a module singleton owned by no
 * component, and the shell that uses it is unmounted the moment the gate closes — so a teardown
 * left to a component would never run, and a socket left open keeps streaming the previous
 * account's run into the store (and spending their credential) after they have signed out.
 *
 * The order is the point. The run has to be told to stop while the socket that carries the frame
 * is still open; the connection has to be closed before the state is cleared, so nothing the
 * previous account's frames say can land in the next account's store; and no connection may exist
 * at all while there is no uid.
 */
export function endAgentSession(): void {
  const live = socket;
  // Nothing is bound: a signed-out boot, or this transition repeating. There is no session to end
  // and nothing a frame could have written, so the store is left alone.
  if (live === null) return;

  // The session the socket was *serving* — the previous account's. Read from what the socket was
  // subscribed to, because by now the auth SDK has already dropped the user: asking
  // `currentSessionId()` here would name the local fallback and cancel nothing.
  const sessionId = subscribedSession ?? socketUid ?? currentSessionId();
  // Sent whenever the socket is open, not only while this window believes a run is in flight: the
  // backend's "nothing was running" answer is free, and a client-side flag is the wrong thing to
  // stake a user's credential on.
  if (live.status === "open") live.cancelAgent(sessionId);

  live.close();
  socket = null;
  socketBase = null;
  socketUid = null;
  subscribedSession = null;
  useAppStore.getState().forgetSession();
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
    sessionId: currentSessionId(),
    phase,
    prompt,
    projectPath,
    // Omitted by callers that just want "run this phase"; the preference decides whether the
    // pipeline then continues on its own.
    autoAdvance: autoAdvance ?? store.autoAdvance,
    // Empty means "whatever the backend is configured with".
    model: store.model || undefined,
    // Read here, with the model, so the two always describe one endpoint: the picker writes them
    // together, and a frame that named a provider but not its model would run the wrong one.
    providerId: store.providerId || undefined,
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
    sessionId: currentSessionId(),
    phase,
    message,
    projectPath,
    model: store.model || undefined,
    providerId: store.providerId || undefined,
    attachments: store.attachments.length > 0 ? store.attachments : null,
    reasoningEffort: store.reasoningEffort || null,
    capabilities: enabledCapabilities(),
    permission: store.permission,
  });
}

function cancelRun(): void {
  socket?.cancelAgent(currentSessionId());
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
  socket?.exec(currentSessionId(), commandId, command, target, null);
  return commandId;
}

function approveCommand(requestId: string, approved: boolean, remember: boolean): void {
  if (!socket) {
    useAppStore.getState().pushLog("error", "Cannot answer: the agent runtime is not connected.");
    return;
  }
  socket.send({ type: "agent.approve", sessionId: currentSessionId(), requestId, approved, remember });
}

function cancelCommand(commandId?: string): void {
  const target = commandId ?? useAppStore.getState().activeCommandId;
  if (!target) return;
  socket?.send({ type: "terminal.cancel", sessionId: currentSessionId(), commandId: target });
}

function watchWorkspace(root: string): void {
  socket?.watch(currentSessionId(), root);
}

/**
 * Make a chat this window's session.
 *
 * The order is deliberate. The id is adopted first, because `currentSessionId()` reads it and the
 * subscribe that follows is what lets the socket's frames for this chat through. Subscribing before
 * the read means a frame that arrives while the read is in flight is applied rather than dropped;
 * the read is what restores the transcript the server owns.
 *
 * A chat whose state cannot be read must not become the session every later frame is sent for, so
 * the switch is undone — id, subscription and all — rather than left half-applied.
 */
async function openChat(id: string): Promise<void> {
  const store = () => useAppStore.getState();
  const previous = store().activeChatId;
  store().setActiveChatId(id);
  subscribedSession = id;
  socket?.subscribe(id);
  try {
    const { chat, state } = await api.chat(id);
    store().mergeChat(chat);
    store().applySession(state);
  } catch (cause) {
    store().setActiveChatId(previous);
    subscribedSession = previous ?? localSessionId();
    socket?.subscribe(subscribedSession);
    store().pushLog("warn", `Could not open the chat: ${errorMessage(cause)}`);
  }
}

function pauseRun(): void {
  const store = useAppStore.getState();
  if (!socket) {
    store.pushLog("error", "Cannot pause: the agent runtime is not connected.");
    return;
  }
  socket.pauseAgent(currentSessionId());
}

function resumeRun(): void {
  const store = useAppStore.getState();
  if (!socket) {
    store.pushLog("error", "Cannot resume: the agent runtime is not connected.");
    return;
  }
  socket.resumeAgent(currentSessionId());
}

function askSideQuestion(question: string): string | null {
  const store = useAppStore.getState();
  if (!socket) {
    store.pushLog("error", "Cannot ask: the agent runtime is not connected.");
    return null;
  }
  // The entry is created before the frame goes out, with the question this window actually asked —
  // the answer frames carry only the id, and the question is half of what a side answer is.
  const requestId = createId("ask");
  store.startSideAnswer(requestId, question);
  socket.askAgent(currentSessionId(), question, requestId);
  return requestId;
}

/** Cuts off one side answer. No session id: the frame names the question, not the run. */
function cancelSideQuestion(requestId: string): void {
  socket?.cancelAsk(requestId);
}

/** Module-level so the function identities — and therefore effect dependencies — are stable. */
const ACTIONS = {
  run: runPhase,
  chat: chatTurn,
  cancel: cancelRun,
  approve: approveCommand,
  exec: execCommand,
  cancelExec: cancelCommand,
  watch: watchWorkspace,
  openChat,
  pause: pauseRun,
  resume: resumeRun,
  ask: askSideQuestion,
  cancelAsk: cancelSideQuestion,
} as const;

export function useAgentSocket(): AgentSocketApi {
  const status = useAppStore((state) => state.socketStatus);
  // Selected rather than read inside the memo: a chat switch must change `sessionId` here, and a
  // selector is what makes this component re-render for it.
  const activeChatId = useAppStore((state) => state.activeChatId);

  // This hook does not open the socket: its life is bound to the signed-in uid, and it is a
  // module singleton — see `openAgentSession` / `endAgentSession` and the effect in `App` that
  // calls them. Opening it from here would tie a connection to whichever panel happened to mount.
  //
  // `sessionId` is the chat this window is on, or the local fallback when there is none. It is the
  // *label* the backend keys a session by; the socket's authority is the runtime token it presented
  // in `auth`, which is what the runtime judges every frame and request against.
  return useMemo(
    () => ({ ...ACTIONS, sessionId: activeChatId ?? localSessionId(), status }),
    [status, activeChatId],
  );
}
