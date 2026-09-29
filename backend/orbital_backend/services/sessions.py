"""Thread-safe session state shared by the REST routes, the WebSocket handler and the
agent runtime — and the chat store that outlives the process.

Every accessor returns a deep snapshot so callers can serialise a session while another
task mutates it. ``ensure`` is the get-or-create entry point used on the hot path.

The chat *is* the session: one id addresses both, which is what keeps the sidebar entry and
the state a run updates from being two different conversations. The disk copy is written at
the boundaries that end something — a message, a tool result, a status change, a
create/rename/clear/delete, and shutdown — because a write per streamed token would put the
user's code on disk hundreds of times a minute and change nothing about what survives. Both
files are closed to other accounts: a transcript holds the user's source and whatever a tool
printed, so it is treated like the credential file rather than like the project registry.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from collections.abc import Iterable
from pathlib import Path

from orbital_backend import config
from orbital_backend.errors import CommandError, NotFoundError, ToolError, logger
from orbital_backend.models import (
    CHAT_TITLE_LIMIT,
    NEW_CHAT_TITLE,
    Chat,
    ChatMessage,
    MessageRole,
    Phase,
    PhaseStatus,
    RunStatus,
    SessionState,
    ToolCall,
    ToolResult,
    UsageSnapshot,
)
from orbital_backend.services.approvals import approvals
from orbital_backend.services.settings_file import restrict_to_user
from orbital_backend.services.workspace import workspace

_log = logger(__name__)

#: The chat store: one directory under the state dir, one index listing every chat, and one
#: transcript per chat beside it. One place to look, and one place to back up or delete.
CHATS_DIR = "chats"
INDEX_FILE = "index.json"


def chats_dir() -> Path:
    """The chat store directory under :func:`orbital_backend.config.state_dir`."""
    return config.state_dir() / CHATS_DIR


def _now() -> int:
    return int(time.time())


def _safe_id(session_id: str) -> str | None:
    """The id when it is a single filename and nothing more, or ``None`` when it is not.

    A signed-out client picks its own id, and the id becomes a path component — so anything
    carrying a separator, a drive or a traversal is refused rather than written outside the store.
    """
    if not session_id or session_id in {".", ".."}:
        return None
    raw = Path(session_id)
    if raw.name != session_id or raw.drive or raw.root:
        return None
    return session_id


def _workspace_key(path: str) -> str:
    """Case-folded absolute key, so one directory is one workspace on a case-insensitive disk."""
    return os.path.normcase(os.path.abspath(path))


def _ordered(chats: Iterable[Chat]) -> list[Chat]:
    """Most recently active first; ties broken by id, so the sidebar order is stable."""
    return sorted(chats, key=lambda chat: (-chat.updated_at, -chat.created_at, chat.id))


def _title_from_message(content: str) -> str:
    """The name a chat takes from the message that opened it: one line, trimmed, bounded."""
    for line in content.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped[:CHAT_TITLE_LIMIT].strip() or NEW_CHAT_TITLE
    return NEW_CHAT_TITLE


def _validated_title(raw: str) -> str:
    """A title the sidebar can render: one line, no stray space, inside the length limit."""
    title = " ".join(str(raw).split())
    if not title:
        raise ToolError("a chat needs a title")
    return title[:CHAT_TITLE_LIMIT].strip()


def _read_index(directory: Path) -> dict[str, Chat]:
    """Read the chat list; anything unreadable is an empty store, with a warning."""
    try:
        text = (directory / INDEX_FILE).read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as exc:
        _log.warning("could not read the chat index at %s: %s", directory, exc)
        return {}
    try:
        payload = json.loads(text)
        chats = [Chat.model_validate(item) for item in payload["chats"]]
    except (ValueError, KeyError, TypeError) as exc:
        _log.warning("ignoring a corrupt chat index at %s: %s", directory, exc)
        return {}
    return {chat.id: chat for chat in chats if _safe_id(chat.id) is not None}


def _read_transcript(directory: Path, session_id: str) -> SessionState | None:
    """Read one transcript; anything unreadable is ``None``, with a warning."""
    path = directory / f"{session_id}.json"
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as exc:
        _log.warning("could not read the chat transcript at %s: %s", path, exc)
        return None
    try:
        payload = json.loads(text)
        return SessionState.model_validate(payload["state"])
    except (ValueError, KeyError, TypeError) as exc:
        _log.warning("ignoring a corrupt chat transcript at %s: %s", path, exc)
        return None


def _write_json(path: Path, payload: object) -> None:
    """Replace one store file in one step, readable by the account that owns it and nobody else.

    Written without the camelCase alias rule: that rule exists for the wire, and this is the
    store. The permissions are applied to the temporary file *before* it is moved into place,
    because ``os.replace`` keeps the permissions the file already has and tightening the final
    path afterwards would leave a window in which a transcript is readable by another account.
    """
    temporary = path.with_name(path.name + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        restrict_to_user(temporary)
        os.replace(temporary, path)
    except OSError as exc:
        raise CommandError(f"could not write the chat store at {path}: {exc}") from exc
    finally:
        # Gone after a successful move; the leftover of a refused one, otherwise.
        temporary.unlink(missing_ok=True)


def _index_payload(chats: Iterable[Chat]) -> dict[str, object]:
    """The index as stored: the wire shape plus the one flag that is the backend's own."""
    return {"chats": [{**chat.model_dump(mode="json"), "renamed": chat.renamed} for chat in chats]}


class SessionStore:
    """In-memory registry of agent sessions, backed by the chat store under the state dir."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, SessionState] = {}
        self._tool_results: dict[str, dict[str, ToolResult]] = {}
        self._chats: dict[str, Chat] = {}
        self._directory: Path | None = None

    # -- chats: the conversation behind the session id ---------------------------------

    def chats(
        self, workspace_path: str | None = None, *, all_workspaces: bool = False
    ) -> list[Chat]:
        """Every chat, most recently active first; one workspace's, or every one."""
        with self._lock:
            self._current()
            found = list(self._chats.values())
        if workspace_path and not all_workspaces:
            wanted = _workspace_key(workspace_path)
            found = [
                chat
                for chat in found
                if chat.workspace is not None and _workspace_key(chat.workspace) == wanted
            ]
        return [chat.model_copy(deep=True) for chat in _ordered(found)]

    def chat(self, session_id: str) -> Chat | None:
        """One chat, or ``None`` when nothing has ever seen that id."""
        with self._lock:
            self._current()
            found = self._chats.get(session_id)
            return None if found is None else found.model_copy(deep=True)

    def ensure_chat(self, session_id: str) -> Chat:
        """The chat for an id, created — and written — when nothing has seen it before.

        This is the get-or-create the socket's ``subscribe`` path relies on: an id the client
        picks is a conversation, not an error.
        """
        with self._lock:
            # The directory is resolved first: if it moved, the live state belongs to the previous
            # one and was just cleared, which is what makes "first seen" true again.
            self._current()
            known = session_id in self._sessions
            self._state(session_id)
            if not known:
                self._persist(session_id)
            return self._chat_record(session_id).model_copy(deep=True)

    def create_chat(
        self,
        *,
        title: str | None = None,
        workspace_path: str | None = None,
        phase: Phase | None = None,
    ) -> Chat:
        """Start a new chat and return it.

        A chat created with a title the user typed counts as renamed, for the same reason an edit
        does: a name chosen deliberately must not be replaced by one derived from a message.
        """
        session_id = uuid.uuid4().hex
        project_path = workspace_path or None
        with self._lock:
            self._current()
            now = _now()
            chat = Chat(
                id=session_id,
                title=NEW_CHAT_TITLE if title is None else _validated_title(title),
                renamed=title is not None,
                workspace=project_path,
                phase=phase or Phase.PLAN,
                created_at=now,
                updated_at=now,
            )
            self._chats[session_id] = chat
            self._sessions[session_id] = SessionState(
                session_id=session_id,
                project_path=project_path,
                active_phase=chat.phase,
            )
            self._tool_results[session_id] = {}
            self._persist(session_id)
            _log.info("created chat %s", session_id)
            return chat.model_copy(deep=True)

    def update_chat(
        self,
        session_id: str,
        *,
        title: str | None = None,
        phase: Phase | None = None,
        provider_id: str | None = None,
        model: str | None = None,
    ) -> Chat:
        """Edit a chat's own fields; ``None`` leaves a field as it was.

        A title set here is a rename, and a rename is permanent: the first user message names a
        chat only while it still carries the default title, so a name the user typed is never
        replaced by one taken from their next message.
        """
        with self._lock:
            self._current()
            chat = self._chats.get(session_id)
            if chat is None:
                raise NotFoundError(f"unknown chat: {session_id}")
            if title is not None:
                chat.title = _validated_title(title)
                chat.renamed = True
            if phase is not None:
                chat.phase = phase
                self._state(session_id).active_phase = phase
            if provider_id is not None:
                chat.provider_id = provider_id or None
            if model is not None:
                chat.model = model or None
            self._persist(session_id)
            return chat.model_copy(deep=True)

    def clear_chat(self, session_id: str) -> tuple[Chat, SessionState]:
        """Empty a chat's transcript and its usage, keeping the chat, its title and its pin."""
        with self._lock:
            self._current()
            chat = self._chats.get(session_id)
            if chat is None:
                raise NotFoundError(f"unknown chat: {session_id}")
            previous = self._state(session_id)
            state = SessionState(
                session_id=session_id,
                project_path=previous.project_path or chat.workspace,
                active_phase=chat.phase,
            )
            self._sessions[session_id] = state
            self._tool_results[session_id] = {}
            self._persist(session_id)
            _log.info("cleared chat %s", session_id)
            return chat.model_copy(deep=True), state.model_copy(deep=True)

    def delete_chat(self, session_id: str) -> list[Chat]:
        """Forget a chat and its transcript, and return what remains."""
        with self._lock:
            self._current()
            if session_id not in self._chats and session_id not in self._sessions:
                raise NotFoundError(f"unknown chat: {session_id}")
            self._forget(session_id)
            return [chat.model_copy(deep=True) for chat in _ordered(self._chats.values())]

    # -- sessions: the live state a run works on ---------------------------------------

    def create(self, session_id: str | None = None) -> SessionState:
        """Create (or overwrite) a session and return its snapshot."""
        state = SessionState(session_id=session_id or uuid.uuid4().hex)
        with self._lock:
            self._sessions[state.session_id] = state
            self._tool_results[state.session_id] = {}
            self._persist(state.session_id)
        return state.model_copy(deep=True)

    def get(self, session_id: str) -> SessionState:
        """Snapshot a session; an unknown id yields an empty, unregistered state."""
        with self._lock:
            state = self._live(session_id)
            if state is None:
                return SessionState(session_id=session_id)
            return state.model_copy(deep=True)

    def ensure(self, session_id: str) -> SessionState:
        """Snapshot a session, creating it first — from the transcript when one is stored — when
        the id is unknown. A first sighting is written, so an id-only client's chat is listed."""
        with self._lock:
            # Resolved before the lookup, for the same reason as :meth:`ensure_chat`: a moved state
            # dir has just reset the live state, and this is then a first sighting again.
            self._current()
            first_seen = session_id not in self._sessions
            state = self._state(session_id)
            if first_seen:
                self._persist(session_id)
            return state.model_copy(deep=True)

    def list(self) -> list[SessionState]:
        with self._lock:
            self._current()
            return [state.model_copy(deep=True) for state in self._sessions.values()]

    def reset(self, session_id: str) -> SessionState:
        """Clear a session's transcript and run state, keeping its project binding."""
        with self._lock:
            previous = self._state(session_id)
            state = SessionState(
                session_id=session_id,
                project_path=previous.project_path,
            )
            self._sessions[session_id] = state
            self._tool_results[session_id] = {}
            self._persist(session_id)
            return state.model_copy(deep=True)

    def drop(self, session_id: str) -> bool:
        """Forget a session, its transcript and its index entry."""
        with self._lock:
            return self._forget(session_id)

    def _forget(self, session_id: str) -> bool:
        """Remove a session's live state, transcript and index entry. Caller holds the lock.

        Not :meth:`drop`, because the lock is not reentrant and the chat routes drop a session
        while already holding it.
        """
        directory = self._current()
        chat = self._chats.pop(session_id, None)
        self._tool_results.pop(session_id, None)
        state = self._sessions.pop(session_id, None)
        if chat is not None or state is not None:
            safe = _safe_id(session_id)
            if safe is not None:
                try:
                    (directory / f"{safe}.json").unlink(missing_ok=True)
                except OSError as exc:
                    _log.warning("could not remove the transcript for %s: %s", session_id, exc)
            self._write_index(directory)
        return chat is not None or state is not None

    def persist_all(self) -> None:
        """Write every live session once, for shutdown.

        A run can be mid-flight when the process is asked to stop, and a transcript that was only
        ever in memory would be the conversation the user just watched go by.
        """
        with self._lock:
            self._current()
            for session_id in list(self._sessions):
                self._persist(session_id)

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
            chat = self._chat_record(session_id)
            if message.role is MessageRole.USER and not chat.renamed:
                # Only while the chat still carries the placeholder: a title already taken from an
                # earlier message is the conversation's name, and re-deriving it from every turn
                # would leave the sidebar showing whichever message arrived last.
                if chat.title == NEW_CHAT_TITLE:
                    chat.title = _title_from_message(message.content)
            self._persist(session_id)

    def append_token(self, session_id: str, message_id: str, text: str) -> None:
        """Append a streamed token, leaving the message marked as still streaming."""
        with self._lock:
            message = self._message(session_id, message_id)
            if message is not None:
                message.content += text

    def end_message(self, session_id: str, message_id: str, content: str) -> None:
        """Seal a streamed message with its final content, and store the finished exchange."""
        with self._lock:
            message = self._message(session_id, message_id)
            if message is not None:
                message.content = content
                message.streaming = False
            self._persist(session_id)

    def add_tool_call(self, session_id: str, message_id: str, call: ToolCall) -> None:
        with self._lock:
            message = self._message(session_id, message_id)
            if message is not None:
                message.tool_calls.append(call)

    def add_tool_result(self, session_id: str, result: ToolResult) -> None:
        """Record a tool result so phase summaries can read back what a run executed."""
        with self._lock:
            self._tool_results.setdefault(session_id, {})[result.id] = result
            self._persist(session_id)

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

    # -- internals ---------------------------------------------------------------------

    def _current(self) -> Path:
        """The store directory and its chat index, reloaded when the setting points elsewhere.

        Keyed on the resolved directory rather than a loaded-once flag, so pointing the backend at
        a different state dir serves *that* directory — and so a second store built over the same
        directory (which is how a restart is exercised) starts from what is on disk. Caller holds
        the lock.
        """
        directory = chats_dir()
        if directory != self._directory:
            self._directory = directory
            self._chats = _read_index(directory)
            # Live state belongs to the directory this store was serving before: the transcript on
            # disk is the truth for the new one, and keeping the old sessions would serve another
            # store's conversation under this one's ids.
            self._sessions.clear()
            self._tool_results.clear()
        return directory

    def _live(self, session_id: str) -> SessionState | None:
        """The live state, restored from the transcript when it is not in memory.

        Caller holds the lock.
        """
        self._current()
        state = self._sessions.get(session_id)
        if state is not None:
            return state
        safe = _safe_id(session_id)
        if safe is None:
            return None
        restored = _read_transcript(self._directory or chats_dir(), safe)
        if restored is None:
            return None
        self._sessions[session_id] = restored
        self._tool_results[session_id] = {}
        return restored

    def _state(self, session_id: str) -> SessionState:
        """Return the live state, creating it when unknown. Caller holds the lock."""
        state = self._live(session_id)
        if state is None:
            state = SessionState(session_id=session_id)
            self._sessions[session_id] = state
            self._tool_results[session_id] = {}
        return state

    def _chat_record(self, session_id: str) -> Chat:
        """The chat record for a session, created when the id is first seen.

        Caller holds the lock.
        """
        chat = self._chats.get(session_id)
        if chat is None:
            now = _now()
            chat = Chat(id=session_id, created_at=now, updated_at=now)
            self._chats[session_id] = chat
        return chat

    def _persist(self, session_id: str) -> None:
        """Write this session's transcript and index entry. Caller holds the lock.

        A refused write is logged and swallowed: the store is a convenience for the next start,
        and a full disk must not fail a run that is otherwise working.
        """
        directory = self._current()
        chat = self._chat_record(session_id)
        state = self._sessions.get(session_id)
        if state is not None:
            chat.workspace = state.project_path
            chat.phase = state.active_phase
            chat.run_status = state.status
            chat.message_count = len(state.messages)
        chat.updated_at = _now()
        safe = _safe_id(session_id)
        if safe is None:
            # The id cannot name a file; the chat still exists for this process, and saying so is
            # more useful than a write outside the store that would be a directory traversal.
            _log.warning("not persisting the chat for unsafe id %r", session_id)
            self._write_index(directory)
            return
        try:
            if state is not None:
                _write_json(directory / f"{safe}.json", {"state": state.model_dump(mode="json")})
            self._write_index(directory)
        except CommandError as exc:
            _log.warning("could not persist the chat for session %s: %s", session_id, exc)

    def _write_index(self, directory: Path) -> None:
        """Replace the index; a refused write is logged, not raised. Caller holds the lock."""
        try:
            _write_json(directory / INDEX_FILE, _index_payload(self._chats.values()))
        except CommandError as exc:
            _log.warning("could not write the chat index at %s: %s", directory, exc)

    def _set_field(self, session_id: str, field_name: str, value: object) -> None:
        with self._lock:
            setattr(self._state(session_id), field_name, value)
            self._persist(session_id)

    def _message(self, session_id: str, message_id: str) -> ChatMessage | None:
        """Return a live message by id. Caller holds the lock."""
        state = self._live(session_id)
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
