"""Thread-safe session state shared by the REST routes, the WebSocket handler and the
agent runtime.

Every accessor returns a deep snapshot so callers can serialise a session while another
task mutates it. ``ensure`` is the get-or-create entry point used on the hot path.
"""

from __future__ import annotations

import threading
import uuid
from pathlib import Path

from orbital_backend.errors import logger
from orbital_backend.models import (
    ChatMessage,
    Phase,
    PhaseStatus,
    RunStatus,
    SessionState,
    ToolCall,
    ToolResult,
    UsageSnapshot,
)
from orbital_backend.services.approvals import approvals
from orbital_backend.services.workspace import workspace

_log = logger(__name__)


class SessionStore:
    """In-memory registry of agent sessions."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, SessionState] = {}
        self._tool_results: dict[str, dict[str, ToolResult]] = {}

    def create(self, session_id: str | None = None) -> SessionState:
        """Create (or overwrite) a session and return its snapshot."""
        state = SessionState(session_id=session_id or uuid.uuid4().hex)
        with self._lock:
            self._sessions[state.session_id] = state
            self._tool_results[state.session_id] = {}
        return state.model_copy(deep=True)

    def get(self, session_id: str) -> SessionState:
        """Snapshot a session; an unknown id yields an empty, unregistered state."""
        with self._lock:
            state = self._sessions.get(session_id)
            if state is None:
                return SessionState(session_id=session_id)
            return state.model_copy(deep=True)

    def ensure(self, session_id: str) -> SessionState:
        """Snapshot a session, creating it first when the id is unknown."""
        with self._lock:
            state = self._sessions.get(session_id)
            if state is None:
                state = SessionState(session_id=session_id)
                self._sessions[session_id] = state
                self._tool_results[session_id] = {}
            return state.model_copy(deep=True)

    def list(self) -> list[SessionState]:
        with self._lock:
            return [state.model_copy(deep=True) for state in self._sessions.values()]

    def reset(self, session_id: str) -> SessionState:
        """Clear a session's transcript and run state, keeping its project binding."""
        with self._lock:
            previous = self._sessions.get(session_id)
            state = SessionState(
                session_id=session_id,
                project_path=None if previous is None else previous.project_path,
            )
            self._sessions[session_id] = state
            self._tool_results[session_id] = {}
            return state.model_copy(deep=True)

    def drop(self, session_id: str) -> bool:
        with self._lock:
            self._tool_results.pop(session_id, None)
            return self._sessions.pop(session_id, None) is not None

    def set_active_phase(self, session_id: str, phase: Phase) -> None:
        self._set_field(session_id, "active_phase", phase)

    def set_status(self, session_id: str, status: RunStatus) -> None:
        self._set_field(session_id, "status", status)

    def set_error(self, session_id: str, error: str | None) -> None:
        self._set_field(session_id, "error", error)

    def set_project_path(self, session_id: str, path: str | None) -> None:
        self._set_field(session_id, "project_path", path)

    def set_phase_status(self, session_id: str, phase: Phase, status: PhaseStatus) -> None:
        with self._lock:
            self._state(session_id).phases[phase] = status

    def add_message(self, session_id: str, message: ChatMessage) -> None:
        with self._lock:
            self._state(session_id).messages.append(message)

    def append_token(self, session_id: str, message_id: str, text: str) -> None:
        """Append a streamed token, leaving the message marked as still streaming."""
        with self._lock:
            message = self._message(session_id, message_id)
            if message is not None:
                message.content += text

    def end_message(self, session_id: str, message_id: str, content: str) -> None:
        """Seal a streamed message with its final content."""
        with self._lock:
            message = self._message(session_id, message_id)
            if message is not None:
                message.content = content
                message.streaming = False

    def add_tool_call(self, session_id: str, message_id: str, call: ToolCall) -> None:
        with self._lock:
            message = self._message(session_id, message_id)
            if message is not None:
                message.tool_calls.append(call)

    def add_tool_result(self, session_id: str, result: ToolResult) -> None:
        """Record a tool result so phase summaries can read back what a run executed."""
        with self._lock:
            self._tool_results.setdefault(session_id, {})[result.id] = result

    def tool_results(self, session_id: str) -> dict[str, ToolResult]:
        with self._lock:
            return dict(self._tool_results.get(session_id, {}))

    def accumulate_usage(self, session_id: str, delta: UsageSnapshot) -> UsageSnapshot:
        """Fold a run's usage into the session totals and return the new snapshot.

        Counters add up; the context high-water mark is a maximum, because it describes a
        single prompt rather than a quantity consumed.
        """
        with self._lock:
            usage = self._state(session_id).usage
            usage.model_calls += delta.model_calls
            usage.tool_calls += delta.tool_calls
            usage.prompt_chars += delta.prompt_chars
            usage.completion_chars += delta.completion_chars
            usage.running_ms += delta.running_ms
            usage.context_tokens = max(usage.context_tokens, delta.context_tokens)
            usage.context_window = max(usage.context_window, delta.context_window)
            return usage.model_copy(deep=True)

    def set_artifact(
        self,
        session_id: str,
        name: str,
        content: str,
        *,
        write_to_disk: bool = False,
    ) -> None:
        """Mirror an artefact into session state, optionally writing it to the project root."""
        with self._lock:
            state = self._state(session_id)
            state.artifacts[name] = content
            project_path = state.project_path
        if write_to_disk:
            _write_artifact(name, content, project_path)

    def _set_field(self, session_id: str, field_name: str, value: object) -> None:
        with self._lock:
            setattr(self._state(session_id), field_name, value)

    def _state(self, session_id: str) -> SessionState:
        """Return the live state, creating it when unknown. Caller holds the lock."""
        state = self._sessions.get(session_id)
        if state is None:
            state = SessionState(session_id=session_id)
            self._sessions[session_id] = state
            self._tool_results[session_id] = {}
        return state

    def _message(self, session_id: str, message_id: str) -> ChatMessage | None:
        """Return a live message by id. Caller holds the lock."""
        state = self._sessions.get(session_id)
        if state is None:
            return None
        for message in state.messages:
            if message.id == message_id:
                return message
        return None


def _write_artifact(name: str, content: str, project_path: str | None) -> None:
    target_root = Path(project_path) if project_path else workspace.root
    if target_root is None:
        _log.warning("skipping disk write for artefact %s: no project root", name)
        return
    safe_name = Path(name).name
    if not safe_name or safe_name in {".", ".."} or safe_name != name:
        _log.warning("refusing to write artefact with unsafe name %r", name)
        return
    (target_root / safe_name).write_text(content, encoding="utf-8")


sessions = SessionStore()


def wire_state(session_id: str) -> SessionState:
    """The session state as the socket sends it: the snapshot plus any command still being held.

    A held command is emitted once, so a client that reconnects while one is waiting would never
    learn it is being asked to decide, and the tool would sit there until the request timed out.
    """
    state = sessions.ensure(session_id)
    return state.model_copy(update={"pending_commands": approvals.pending(session_id)})
