"""Drive one agent run and translate LangGraph's event stream into wire frames.

The graph is streamed with ``stream_mode=["messages", "updates"]`` and
``subgraphs=True``. That yields ``(namespace, mode, payload)`` triples where:

* ``namespace == ()``            → the supervisor level (orchestrator).
* ``namespace == ("architect:…",)`` → one specialist subgraph.

Token frames are derived only from specialist namespaces, because the orchestrator
announces its (short, atomic) turns itself and tool calls announce themselves from
inside ``orbital_backend.tools``. Nothing is emitted twice.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from orbital_backend.config import settings
from orbital_backend.errors import (
    OrbitalError,
    LLMNotConfigured,
    WorkspaceError,
    provider_message,
)
from orbital_backend.events import bus
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage
from orbital_backend.models import (
    AGENTS_MD_PATH,
    PHASE_SPECS,
    ARTIFACT_PATHS,
    AgentId,
    ChatMessage,
    MessageRole,
    Permission,
    Phase,
    PhaseStatus,
    RunStatus,
    SessionState,
    UsageSnapshot,
)
from orbital_backend.services.approvals import approvals
from orbital_backend.services.attachments import build_chat_context, build_run_context
from orbital_backend.services.sessions import sessions, wire_state

from .graph import (
    RECURSION_LIMIT,
    RunContext,
    build_chat_agent,
    build_graph,
    message_text,
)
from .llm import assert_llm_available, note_credential
from .retry import TRANSIENT_HINT, is_credential_failure, is_transient
from .usage import UsageRecorder, estimate_tokens

logger = logging.getLogger(__name__)

#: Ceiling on the discussion replayed into a plan run. The conversation is context, not an
#: archive, and every character here is paid for on every model call of the run.
TRANSCRIPT_CHAR_BUDGET = 8000

#: Ceiling on tool invocations for a single run. A specialist that loops is stopped here
#: with a clear message rather than burning the model budget.
MAX_TOOL_CALLS = 80

#: Artefacts are mirrored into session state, which is pushed over the socket — cap them.
ARTIFACT_READ_LIMIT = 200_000

#: Longest failure message pushed to the UI and stored on the session.
FAILURE_TEXT_LIMIT = 500

_HTML_TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_HTML_TAG = re.compile(r"<[^>]+>")
_URL = re.compile(r"https?://[^\s\"'<>]+")
_WHITESPACE = re.compile(r"\s+")

#: The misconfigurations that actually happen; keyed by HTTP status.
_FAILURE_HINTS: dict[int, str] = {
    401: "the endpoint rejected the key — replace it in Settings (or ORBITAL_LLM_API_KEY)",
    403: "the endpoint refused the key — check its permissions in Settings (or ORBITAL_LLM_API_KEY)",
    404: "that endpoint path does not exist — check ORBITAL_LLM_BASE_URL",
    429: "rate limited, out of credit, or over a usage limit",
}


def _collapse(text: str) -> str:
    """Squash an error body onto one line so it stays readable in a chat bubble."""
    return _WHITESPACE.sub(" ", text).strip()


def _short_reason(body: str) -> str:
    """Pull one readable line out of a JSON error envelope or an HTML error page."""
    text = body.strip()
    if not text:
        return ""
    envelope = provider_message(text)
    if envelope:
        return envelope[:300]
    title = _HTML_TITLE.search(text)
    if title:
        return _collapse(title.group(1))[:300]
    if "<" in text and ">" in text:
        return _collapse(_HTML_TAG.sub(" ", text))[:300]
    return _collapse(text)[:300]


def describe_failure(exc: BaseException, *, remedy: bool = True) -> str:
    """Reduce a provider or transport failure to one actionable line.

    A misrouted gateway request answers with an HTML error page, and ``str(exc)`` on one of
    those is tens of kilobytes of markup — useless in the chat panel, the Problems tab and
    the session error. Keep the status, the gateway's own reason and the URL that was
    requested, then name the misconfiguration for the statuses that actually occur.

    ``remedy=False`` drops that last clause: it is what gets *stored* about a failure, and a
    stored reason that already contains the instruction reads as a stutter once the message
    that reports it adds the instruction again.
    """
    status = getattr(exc, "status_code", None)
    response = getattr(exc, "response", None)
    body = getattr(response, "text", "") or str(exc)
    reason = _short_reason(body)
    url = str(getattr(getattr(response, "request", None), "url", "") or "")
    if not url:
        found = _URL.search(str(exc))
        url = found.group(0) if found else ""

    parts = [f"HTTP {status}" if isinstance(status, int) else type(exc).__name__]
    if reason:
        parts.append(reason)
    if remedy:
        if is_transient(exc):
            parts.append(TRANSIENT_HINT)
        elif isinstance(status, int) and status in _FAILURE_HINTS:
            parts.append(_FAILURE_HINTS[status])
    if url:
        parts.append(f"(requested {url})")

    message = " — ".join(parts)
    if len(message) > FAILURE_TEXT_LIMIT:
        message = f"{message[:FAILURE_TEXT_LIMIT].rstrip()}…"
    return message


def _report_unexpected(exc: BaseException, what: str) -> str:
    """Log a failure at the level it deserves, and return the line the user should see.

    A refused key is a configuration mistake with a one-line remedy, not a bug: printing a
    provider traceback for it buries the remedy and trains the reader to ignore tracebacks.
    Anything else is a genuine surprise and keeps its stack. Either way the credential verdict
    is recorded, so the next attempt fails immediately instead of rediscovering it mid-turn.
    """
    detail = describe_failure(exc)
    if is_credential_failure(exc):
        note_credential("rejected", describe_failure(exc, remedy=False))
        logger.error("%s: %s", what, detail)
    else:
        logger.exception(what)
    return detail


@dataclass(slots=True)
class _Run:
    task: asyncio.Task[None]
    phase: Phase


_runs: dict[str, _Run] = {}


# -------------------------------------------------------------------------------------
# Session helpers
# -------------------------------------------------------------------------------------


def _now_ms() -> int:
    return int(time.time() * 1000)


async def _publish(session_id: str) -> None:
    """Push the whole session snapshot so a client can resynchronise after any change."""
    await bus.emit("session.state", wire_state(session_id), session_id=session_id)


async def refresh_artifacts(session_id: str, root: Path) -> None:
    """Mirror the pipeline's artefacts from disk into session state."""
    for name in ARTIFACT_PATHS:
        target = root / name
        try:
            if not target.is_file():
                continue
            content = target.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            logger.warning("could not read artefact %s: %s", name, exc)
            continue
        if len(content) > ARTIFACT_READ_LIMIT:
            content = f"{content[:ARTIFACT_READ_LIMIT]}\n... [truncated]"
        sessions.set_artifact(session_id, name, content)
        await bus.emit("artifact.updated", {"name": name, "content": content}, session_id=session_id)


def _record_user_message(session_id: str, phase: Phase, text: str) -> None:
    """Store the user's turn in the session.

    The UI keeps its own copy for instant feedback, but the session is what a later plan run
    replays — so a discussion is only usable as context if both halves were recorded here.
    """
    sessions.add_message(
        session_id,
        ChatMessage(
            id=uuid4().hex,
            role=MessageRole.USER,
            agent=AgentId.ORCHESTRATOR,
            content=text,
            phase=phase,
            created_at=_now_ms(),
            streaming=False,
        ),
    )


def _conversation_seed(session_id: str) -> tuple[AnyMessage, ...]:
    """Prior turns, replayed so a confirmed plan is written from what was actually discussed.

    Newest-last and capped by a character budget: the discussion is context for the write, not
    an archive to resend in full.
    """
    seeded: list[AnyMessage] = []
    budget = TRANSCRIPT_CHAR_BUDGET
    for message in reversed(sessions.get(session_id).messages):
        if message.role not in (MessageRole.USER, MessageRole.ASSISTANT):
            continue
        text = message.content.strip()
        if not text:
            continue
        if len(text) > budget:
            break
        budget -= len(text)
        seeded.append(HumanMessage(text) if message.role is MessageRole.USER else AIMessage(text))
    seeded.reverse()
    return tuple(seeded)


def _chat_message(phase: Phase, message: str, attachments: list[str] | None) -> HumanMessage:
    """The user's turn as the specialist receives it: the attachments, then the message.

    A turn with nothing attached stays a plain string message, so the ordinary conversation is
    byte-for-byte what it was. With an attachment the content becomes parts — the attachment
    block first, then an ``image_url`` part per image, then the message — because that is the
    only shape in which a vision-capable model can look at a picture the user attached.
    """
    context = build_chat_context(attachments)
    text = f"PHASE: {phase.value}\n\n{message}"
    if not context.text:
        return HumanMessage(text)
    parts: list[dict[str, Any]] = [{"type": "text", "text": context.text}]
    parts.extend(context.images)
    parts.append({"type": "text", "text": text})
    return HumanMessage(content=parts)


def _agents_markdown(state: SessionState, summary: str) -> str:
    """Render the persistent project-state document the orchestrator maintains."""
    lines = [
        "# Agents",
        "",
        "Project state maintained by the Orbital orchestrator. Rewritten after every phase.",
        "",
        "| field | value |",
        "| --- | --- |",
        f"| active phase | `{state.active_phase.value}` |",
        f"| run status | `{state.status.value}` |",
        f"| model | `{settings.llm_model}` |",
        f"| updated | {datetime.now(UTC).isoformat(timespec='seconds')} |",
        "",
        "## Pipeline",
        "",
        "| # | phase | agent | status | deliverable |",
        "| --- | --- | --- | --- | --- |",
    ]
    for spec in PHASE_SPECS:
        status = state.phases.get(spec.id, PhaseStatus.IDLE)
        lines.append(
            f"| {spec.index} | {spec.title} | `{spec.agent.value}` | {status.value} "
            f"| `{spec.deliverable}` |"
        )
    lines += ["", "## Artefacts", ""]
    present = [name for name in ARTIFACT_PATHS if name in state.artifacts]
    if present:
        for name in present:
            lines.append(f"- `{name}` — {len(state.artifacts[name])} bytes")
    else:
        lines.append("_none yet_")
    lines += ["", "## Orchestrator decisions", ""]
    decisions = [
        message.content.strip().splitlines()[0]
        for message in state.messages
        if message.agent is AgentId.ORCHESTRATOR
        and message.role is MessageRole.ASSISTANT
        and message.content.strip()
    ]
    for line in decisions[-12:] if decisions else ["_none yet_"]:
        lines.append(f"- {line}")
    lines += ["", "## Last verdict", "", summary.strip() or "_none_", ""]
    return "\n".join(lines)


def _write_agents_md(session_id: str, root: Path, summary: str) -> None:
    state = sessions.get(session_id)
    content = _agents_markdown(state, summary)
    try:
        target = root / AGENTS_MD_PATH
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    except OSError as exc:
        logger.warning("could not write %s: %s", AGENTS_MD_PATH, exc)
        return
    sessions.set_artifact(session_id, AGENTS_MD_PATH, content)


async def _finalize(
    session_id: str,
    phase: Phase,
    status: RunStatus,
    summary: str,
    *,
    phase_status: PhaseStatus,
    error: str | None,
) -> None:
    sessions.set_status(session_id, status)
    sessions.set_phase_status(session_id, phase, phase_status)
    sessions.set_error(session_id, error)
    await bus.emit(
        "phase.changed",
        {"phase": phase.value, "status": phase_status.value},
        session_id=session_id,
    )
    await bus.emit(
        "agent.done",
        {"phase": phase.value, "status": status.value, "summary": summary},
        session_id=session_id,
    )
    await _publish(session_id)


async def _fail(session_id: str, agent: AgentId, message: str) -> None:
    """Report a fatal run error to the UI and settle the session in an error state."""
    phase = sessions.get(session_id).active_phase
    await bus.emit(
        "agent.error",
        {"agent": agent.value, "message": message, "detail": None},
        session_id=session_id,
    )
    await _finalize(
        session_id,
        phase,
        RunStatus.ERROR,
        message,
        phase_status=PhaseStatus.ERROR,
        error=message,
    )


# -------------------------------------------------------------------------------------
# Stream translation
# -------------------------------------------------------------------------------------


def _name_of(namespace: tuple[str, ...]) -> str:
    """Reduce a LangGraph namespace such as ``("architect:uuid",)`` to its node name."""
    return namespace[0].split(":", 1)[0] if namespace else ""


class _Tracker:
    """Turns the raw LangGraph stream into session mutations and wire frames.

    Keeps the bookkeeping that streaming needs — which message is still open per
    specialist, how much text has arrived, and which phase the supervisor is in — out
    of the graph itself.
    """

    def __init__(
        self,
        session_id: str,
        phase: Phase,
        root: Path,
        context_window: int = 0,
        root_agent: AgentId | None = None,
    ) -> None:
        self.session_id = session_id
        self.phase = phase
        self.root = root
        #: Set when the agent being streamed *is* the root graph (a discussion turn) rather
        #: than a subgraph of the supervisor, in which case its nodes have no namespace.
        self.root_agent = root_agent
        self.agent = AgentId.ORCHESTRATOR
        self.verdict = ""
        self.summary = ""
        self.tool_calls = 0
        self.model_calls = 0
        self.output_chars = 0
        self.context_window = context_window
        #: Usage measured from LangChain callbacks; attached to the run's config.
        self.recorder = UsageRecorder()
        #: What has already been folded into the session totals, so flushes can send deltas.
        self.reported = UsageSnapshot()
        self.started = time.perf_counter()
        self._open: dict[str, str] = {}
        self._text: dict[str, str] = {}

    def elapsed_ms(self) -> int:
        return int((time.perf_counter() - self.started) * 1000)

    async def flush_usage(self) -> None:
        """Fold newly measured usage into the session and tell the UI.

        A delta is sent rather than a total: the session accumulates, so reporting the same
        numbers twice would inflate them. Called at each model-turn boundary, which makes the
        context gauge move while a phase is still running.
        """
        if (
            self.recorder.model_calls == self.reported.model_calls
            and self.tool_calls == self.reported.tool_calls
        ):
            return
        running_ms = self.elapsed_ms()
        context_tokens = estimate_tokens(self.recorder.peak_prompt_chars)
        delta = UsageSnapshot(
            model_calls=self.recorder.model_calls - self.reported.model_calls,
            tool_calls=self.tool_calls - self.reported.tool_calls,
            prompt_chars=self.recorder.prompt_chars - self.reported.prompt_chars,
            completion_chars=self.recorder.completion_chars - self.reported.completion_chars,
            # A high-water mark, not a quantity: the session keeps the maximum.
            context_tokens=context_tokens,
            context_window=self.context_window,
            running_ms=max(0, running_ms - self.reported.running_ms),
        )
        snapshot = sessions.accumulate_usage(self.session_id, delta)
        self.reported = UsageSnapshot(
            model_calls=self.recorder.model_calls,
            tool_calls=self.tool_calls,
            prompt_chars=self.recorder.prompt_chars,
            completion_chars=self.recorder.completion_chars,
            context_tokens=context_tokens,
            context_window=self.context_window,
            running_ms=running_ms,
        )
        await bus.emit("usage.updated", snapshot, session_id=self.session_id)

    # -- message streaming ----------------------------------------------------------

    async def _set_agent(self, agent: AgentId) -> None:
        if agent is self.agent:
            return
        self.agent = agent
        await bus.emit(
            "agent.node",
            {"node": agent.value, "agent": agent.value, "phase": self.phase.value},
            session_id=self.session_id,
        )

    async def _stream(self, agent: AgentId, text: str) -> None:
        key = agent.value
        message_id = self._open.get(key)
        if message_id is None:
            message_id = uuid4().hex
            self._open[key] = message_id
            self._text[message_id] = ""
            sessions.add_message(
                self.session_id,
                ChatMessage(
                    id=message_id,
                    role=MessageRole.ASSISTANT,
                    agent=agent,
                    content="",
                    phase=self.phase,
                    created_at=_now_ms(),
                    streaming=True,
                ),
            )
            await bus.emit(
                "agent.message.start",
                {"messageId": message_id, "agent": agent.value, "phase": self.phase.value},
                session_id=self.session_id,
            )
        self._text[message_id] += text
        self.output_chars += len(text)
        sessions.append_token(self.session_id, message_id, text)
        await bus.emit(
            "agent.token", {"messageId": message_id, "text": text}, session_id=self.session_id
        )

    async def _close(self, key: str, final: str = "") -> None:
        message_id = self._open.pop(key, None)
        if message_id is None:
            return
        content = final or self._text.pop(message_id, "")
        sessions.end_message(self.session_id, message_id, content)
        await bus.emit(
            "agent.message.end", {"messageId": message_id, "content": content}, session_id=self.session_id
        )

    async def close_all(self) -> None:
        for key in list(self._open):
            await self._close(key)

    # -- phase movement -------------------------------------------------------------

    async def _enter_phase(self, phase: Phase) -> None:
        await self.close_all()
        await bus.emit(
            "phase.changed",
            {"phase": self.phase.value, "status": PhaseStatus.DONE.value},
            session_id=self.session_id,
        )
        sessions.set_phase_status(self.session_id, self.phase, PhaseStatus.DONE)
        self.phase = phase
        sessions.set_active_phase(self.session_id, phase)
        sessions.set_phase_status(self.session_id, phase, PhaseStatus.RUNNING)
        await bus.emit(
            "phase.changed",
            {"phase": phase.value, "status": PhaseStatus.RUNNING.value},
            session_id=self.session_id,
        )
        await refresh_artifacts(self.session_id, self.root)
        await _publish(self.session_id)

    # -- stream handlers ------------------------------------------------------------

    async def _on_message(self, namespace: tuple[str, ...], payload: Any) -> None:
        chunk, metadata = payload
        if namespace:
            agent = self._agent_for(namespace)
        elif self.root_agent is not None:
            agent = self.root_agent
        else:
            return  # supervisor turns announce themselves from the node
        if metadata.get("langgraph_node") != "model":
            return  # tool traffic is announced by the tools themselves
        await self._set_agent(agent)
        content = chunk.content
        if isinstance(content, str) and content:
            await self._stream(agent, content)

    async def _handle_node_updates(self, key: str, payload: dict[str, Any]) -> None:
        """Model/tool bookkeeping for one graph node, at any nesting level."""
        for node_name, update in payload.items():
            if node_name == "model":
                # One update per model turn, whether or not the provider reported usage.
                self.model_calls += 1
                final = ""
                messages = update.get("messages") if isinstance(update, dict) else None
                if isinstance(messages, list) and messages:
                    candidate = message_text(messages[-1])
                    if candidate.strip():
                        final = candidate
                await self._close(key, final)
                await self.flush_usage()
            elif node_name == "tools" and isinstance(update, dict):
                produced = update.get("messages")
                if isinstance(produced, list):
                    self.tool_calls += len(produced)

    async def _on_updates(self, namespace: tuple[str, ...], payload: Any) -> None:
        if not isinstance(payload, dict):
            return
        if namespace:
            await self._handle_node_updates(_name_of(namespace), payload)
            return
        if self.root_agent is not None:
            # A discussion turn streams its own root graph, so its nodes are at the top level.
            await self._handle_node_updates(self.root_agent.value, payload)
            return

        update = payload.get("orchestrator")
        if not isinstance(update, dict):
            return
        self.model_calls += 1
        await self._set_agent(AgentId.ORCHESTRATOR)
        await self.flush_usage()
        upcoming = update.get("phase")
        if isinstance(upcoming, str) and upcoming != self.phase.value:
            await self._enter_phase(Phase(upcoming))
        verdict = update.get("verdict")
        if isinstance(verdict, str) and verdict:
            self.verdict = verdict
        summary = update.get("summary")
        if isinstance(summary, str) and summary.strip():
            self.summary = summary.strip()

    def _agent_for(self, namespace: tuple[str, ...]) -> AgentId:
        name = _name_of(namespace)
        for agent in AgentId:
            if agent.value == name:
                return agent
        return AgentId.ORCHESTRATOR

    async def handle(self, item: Any) -> None:
        namespace, mode, payload = item
        if mode == "messages":
            await self._on_message(namespace, payload)
        elif mode == "updates":
            await self._on_updates(namespace, payload)


# -------------------------------------------------------------------------------------
# Public entry points
# --------------------------------------------------------------------------------------


async def start_run(
    session_id: str,
    phase: Phase,
    prompt: str,
    project_path: str,
    auto_advance: bool,
    model: str | None = None,
    *,
    attachments: list[str] | None = None,
    reasoning_effort: str | None = None,
    capabilities: list[str] | None = None,
    permission: Permission | None = None,
) -> None:
    """Run one pipeline execution to completion, streaming events as it goes.

    Awaited for the whole run; the WebSocket handler wraps it in a task so the socket
    stays responsive. Registers itself for :func:`cancel_run`.
    """
    existing = _runs.get(session_id)
    if existing is not None and not existing.task.done():
        await bus.emit(
            "agent.error",
            {
                "agent": AgentId.ORCHESTRATOR.value,
                "message": "A run is already active for this session. Cancel it first.",
                "detail": None,
            },
            session_id=session_id,
        )
        return
    task = asyncio.current_task()
    if task is None:  # pragma: no cover - only reachable if called outside asyncio
        raise RuntimeError("start_run must run inside an asyncio task")
    _runs[session_id] = _Run(task=task, phase=phase)
    try:
        await _drive(
            session_id,
            phase,
            prompt,
            project_path,
            auto_advance,
            model,
            attachments=attachments,
            reasoning_effort=reasoning_effort,
            capabilities=capabilities,
            permission=permission,
        )
        # The model answered, so the key works: a verdict from an earlier refusal must not
        # outlive the evidence that replaced it.
        note_credential("ok")
    except asyncio.CancelledError:
        await _finalize(
            session_id,
            sessions.get(session_id).active_phase,
            RunStatus.CANCELLED,
            "Run cancelled.",
            phase_status=PhaseStatus.IDLE,
            error=None,
        )
        raise
    except LLMNotConfigured as exc:
        await _fail(session_id, AgentId.ORCHESTRATOR, exc.detail)
    except OrbitalError as exc:
        await _fail(session_id, AgentId.ORCHESTRATOR, exc.detail)
    except Exception as exc:  # noqa: BLE001 - the UI must always receive a terminal frame
        await _fail(session_id, AgentId.ORCHESTRATOR, _report_unexpected(exc, "agent run failed"))
    finally:
        # A blanket "allow all" lasts exactly as long as the run that granted it.
        approvals.forget(session_id)
        _runs.pop(session_id, None)


async def cancel_run(session_id: str) -> bool:
    """Cancel the active run for a session. Returns False when nothing was running."""
    run = _runs.get(session_id)
    if run is None or run.task.done():
        return False
    run.task.cancel()
    return True


async def _drive(
    session_id: str,
    phase: Phase,
    prompt: str,
    project_path: str,
    auto_advance: bool,
    model: str | None = None,
    *,
    attachments: list[str] | None = None,
    reasoning_effort: str | None = None,
    capabilities: list[str] | None = None,
    permission: Permission | None = None,
) -> None:
    assert_llm_available()
    root = Path(project_path)
    if not root.is_dir():
        raise WorkspaceError(f"Project folder does not exist: {project_path}")
    started = time.perf_counter()

    # The brief is a string, so an attached image arrives as its name and size — see
    # ``build_run_context``. The block goes on the phase prompt, which is what the orchestrator
    # writes the brief from; the user's own words stay what the session records.
    context_block = build_run_context(attachments)
    run_prompt = f"{prompt}\n\n{context_block}" if context_block else prompt

    sessions.ensure(session_id)
    sessions.set_project_path(session_id, project_path)
    sessions.set_status(session_id, RunStatus.RUNNING)
    sessions.set_error(session_id, None)
    sessions.set_active_phase(session_id, phase)
    sessions.set_phase_status(session_id, phase, PhaseStatus.RUNNING)
    _record_user_message(session_id, phase, prompt)
    await bus.emit(
        "phase.changed",
        {"phase": phase.value, "status": PhaseStatus.RUNNING.value},
        session_id=session_id,
    )
    await refresh_artifacts(session_id, root)
    await _publish(session_id)

    ctx = RunContext(
        session_id=session_id,
        project_path=project_path,
        prompt=run_prompt,
        phase=phase,
        auto_advance=auto_advance,
        emit=bus.emit,
        bus=bus,
        model=model,
        reasoning_effort=reasoning_effort,
        # The plan phase is conversational, so its write replays the discussion that produced
        # the agreement. Other phases start clean.
        transcript=_conversation_seed(session_id) if phase is Phase.PLAN else (),
        capabilities=capabilities,
        permission=permission,
    )
    # Before the graph is built: the user's standing choice has to be in place for the first
    # command the run issues, not from the second one on.
    approvals.set_permission(session_id, ctx.permission)
    graph = build_graph(ctx)
    if ctx.transcript:
        logger.info(
            "plan run seeded with %d prior messages (%d chars)",
            len(ctx.transcript),
            sum(len(message_text(message)) for message in ctx.transcript),
        )
    initial: dict[str, Any] = {
        "session_id": session_id,
        "prompt": run_prompt,
        "phase": phase.value,
        "stage": "pre",
        "attempts": 0,
        "next_agent": "orchestrator",
        "messages": list(ctx.transcript),
    }
    tracker = _Tracker(
        session_id=session_id, phase=phase, root=root, context_window=settings.context_window
    )
    stream = graph.astream(
        initial,
        {
            "recursion_limit": RECURSION_LIMIT,
            "configurable": {"thread_id": session_id},
            # Usage is measured from the model calls themselves, not from any transport report.
            "callbacks": [tracker.recorder],
        },
        stream_mode=["messages", "updates"],
        subgraphs=True,
    )
    async for item in stream:
        await tracker.handle(item)
        if tracker.tool_calls > MAX_TOOL_CALLS:
            raise OrbitalError(
                f"Run stopped after {tracker.tool_calls} tool calls "
                f"(limit {MAX_TOOL_CALLS}) — the agent was looping."
            )
    await tracker.close_all()
    await tracker.flush_usage()

    # One line per run, surfaced in the app's Logs tab so the numbers the prompt and context
    # budgets are tuned against stay visible. Deliberately self-measured: gateway-reported
    # token usage proved unreliable (one run reported ~9M input tokens for a single call), so
    # this counts the model turns and the characters the model actually emitted.
    profile = (
        f"{tracker.model_calls} model calls · "
        f"{tracker.output_chars:,} chars out · "
        f"{tracker.tool_calls} tool calls · "
        f"{time.perf_counter() - started:.1f}s"
    )
    logger.info(
        "run finished session=%s phase=%s verdict=%s %s",
        session_id,
        tracker.phase.value,
        tracker.verdict or "n/a",
        profile,
    )
    await bus.emit(
        "log",
        {"level": "info", "message": f"phase {tracker.phase.value} finished — {profile}"},
        session_id=session_id,
    )

    await refresh_artifacts(session_id, tracker.root)
    if tracker.verdict == "ADVANCE":
        _write_agents_md(session_id, root, tracker.summary)
        await refresh_artifacts(session_id, root)
        await _finalize(
            session_id,
            tracker.phase,
            RunStatus.DONE,
            tracker.summary or f"Phase {tracker.phase.value} complete.",
            phase_status=PhaseStatus.DONE,
            error=None,
        )
        return

    _write_agents_md(session_id, root, tracker.summary)
    await _finalize(
        session_id,
        tracker.phase,
        RunStatus.DONE,
        tracker.summary or f"Phase {tracker.phase.value} needs attention.",
        phase_status=PhaseStatus.ERROR,
        error=tracker.summary or f"Phase {tracker.phase.value} did not meet its bar.",
    )


# -------------------------------------------------------------------------------------
# Conversational turns
# -------------------------------------------------------------------------------------


async def start_chat(
    session_id: str,
    phase: Phase,
    message: str,
    project_path: str,
    model: str | None = None,
    *,
    attachments: list[str] | None = None,
    reasoning_effort: str | None = None,
    capabilities: list[str] | None = None,
    permission: Permission | None = None,
) -> None:
    """One conversational turn with a phase's specialist.

    No orchestrator, no verdict and no artefact: this exists so the plan can be agreed in
    conversation and written only once the user confirms it. Registers itself for cancellation
    exactly as a run does, so the composer's Stop button works mid-discussion.
    """
    existing = _runs.get(session_id)
    if existing is not None and not existing.task.done():
        await bus.emit(
            "agent.error",
            {
                "agent": AgentId.ARCHITECT.value,
                "message": "The agent is already working on this session. Cancel it first.",
                "detail": None,
            },
            session_id=session_id,
        )
        return
    task = asyncio.current_task()
    if task is None:  # pragma: no cover - only reachable if called outside asyncio
        raise RuntimeError("start_chat must run inside an asyncio task")
    _runs[session_id] = _Run(task=task, phase=phase)
    try:
        await _drive_chat(
            session_id,
            phase,
            message,
            project_path,
            model,
            attachments=attachments,
            reasoning_effort=reasoning_effort,
            capabilities=capabilities,
            permission=permission,
        )
        note_credential("ok")
    except asyncio.CancelledError:
        await _settle_chat(session_id, phase, RunStatus.CANCELLED, None, "Discussion cancelled.")
        raise
    except LLMNotConfigured as exc:
        await _settle_chat(session_id, phase, RunStatus.IDLE, exc.detail, exc.detail)
    except OrbitalError as exc:
        await _settle_chat(session_id, phase, RunStatus.IDLE, exc.detail, exc.detail)
    except Exception as exc:  # noqa: BLE001 - the UI must always get a terminal frame
        detail = _report_unexpected(exc, "discussion turn failed")
        await _settle_chat(session_id, phase, RunStatus.IDLE, detail, detail)
    finally:
        approvals.forget(session_id)
        _runs.pop(session_id, None)


async def _settle_chat(
    session_id: str,
    phase: Phase,
    status: RunStatus,
    error: str | None,
    summary: str,
) -> None:
    """End a discussion turn without disturbing phase status.

    A conversation is not a phase run, so a phase that already produced its artefact keeps its
    ``done`` status even when a turn fails.
    """
    sessions.set_status(session_id, status)
    sessions.set_error(session_id, error)
    await bus.emit(
        "agent.done",
        {"phase": phase.value, "status": status.value, "summary": summary},
        session_id=session_id,
    )
    await _publish(session_id)


async def _drive_chat(
    session_id: str,
    phase: Phase,
    message: str,
    project_path: str,
    model: str | None,
    *,
    attachments: list[str] | None = None,
    reasoning_effort: str | None = None,
    capabilities: list[str] | None = None,
    permission: Permission | None = None,
) -> None:
    assert_llm_available()
    root = Path(project_path)
    if not root.is_dir():
        raise WorkspaceError(f"Project folder does not exist: {project_path}")

    sessions.ensure(session_id)
    sessions.set_project_path(session_id, project_path)
    sessions.set_error(session_id, None)
    _record_user_message(session_id, phase, message)
    await _publish(session_id)

    ctx = RunContext(
        session_id=session_id,
        project_path=project_path,
        prompt=message,
        phase=phase,
        auto_advance=False,
        emit=bus.emit,
        bus=bus,
        model=model,
        reasoning_effort=reasoning_effort,
        capabilities=capabilities,
        permission=permission,
    )
    # Before the agent is built, exactly as in a run: a discussion turn may write the deliverable,
    # and any command it is allowed to issue has to see the user's choice from its first call.
    approvals.set_permission(session_id, ctx.permission)
    agent = build_chat_agent(ctx)
    tracker = _Tracker(
        session_id=session_id,
        phase=phase,
        root=root,
        context_window=settings.context_window,
        root_agent=AgentId.ARCHITECT,
    )
    # The seed already ends with the user's turn that _record_user_message just stored; the
    # new message is appended explicitly so the phase header — and anything attached — goes
    # with it.
    history = [
        *_conversation_seed(session_id)[:-1],
        _chat_message(phase, message, attachments),
    ]
    stream = agent.astream(
        {"messages": history},
        {
            "recursion_limit": RECURSION_LIMIT,
            "configurable": {"thread_id": session_id},
            "callbacks": [tracker.recorder],
        },
        stream_mode=["messages", "updates"],
        subgraphs=True,
    )
    async for item in stream:
        await tracker.handle(item)
        if tracker.tool_calls > MAX_TOOL_CALLS:
            raise OrbitalError(
                f"Discussion stopped after {tracker.tool_calls} tool calls "
                f"(limit {MAX_TOOL_CALLS}) — the agent was looping."
            )
    await tracker.close_all()
    await tracker.flush_usage()
    await _settle_chat(session_id, phase, RunStatus.IDLE, None, "Discussion turn complete.")
