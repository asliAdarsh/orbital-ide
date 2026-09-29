"""The Orbital agent graph — one supervisor and three specialists, in LangGraph.

Shape
-----

    START ──▶ orchestrator ──┬──▶ architect ────┐
              ▲              ├──▶ code_engine ──┤
              └──────────────┴──▶ qa ───────────┘ ──▶ END

The orchestrator runs twice per phase: once to write the specialist's brief, once to
judge the result and decide ``ADVANCE`` / ``RETRY`` / ``STOP``. ``ADVANCE`` while
``auto_advance`` is set moves to the next phase and re-enters the orchestrator, so one
graph execution can drive all five phases of the pipeline.

Each specialist is a LangChain ``create_agent`` subgraph. Its ReAct loop, tool binding
and message bookkeeping are library behaviour, not hand-rolled code — the graph only
decides *which* specialist runs, with *which* brief, and what happens next.

Nodes reach the event bus, the workspace root and the session store through closures
created by :func:`build_graph`, so the graph is compiled per run. Compilation costs
microseconds and this keeps every node free of module-level mutable state.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Awaitable, Callable, Literal, TypedDict
from uuid import uuid4

from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool
from langgraph.graph import END, START, StateGraph, add_messages
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command, RetryPolicy

from orbital_backend.errors import logger as _error_logger
from orbital_backend.events import EventBus, bus
from orbital_backend.models import (
    ARTIFACT_PATHS,
    DESIGN_DIR,
    PHASE_AGENT,
    PHASE_SPEC_BY_ID,
    PLAN_PATH,
    AgentId,
    ChatMessage,
    CommandRequest,
    MessageRole,
    Permission,
    Phase,
    ProviderProfile,
    next_phase,
)
from orbital_backend.services.approvals import approvals
from orbital_backend.services.projects import projects
from orbital_backend.services.sessions import sessions
from orbital_backend.tools import ToolContext, apply_capabilities, tools_for

from .llm import build_llm
from .prompts import (
    DISCUSSION_RULES,
    ORCHESTRATOR_BRIEF,
    ORCHESTRATOR_VERDICT,
    SPECIALIST_PROMPTS,
    repository_block,
    environment_block,
)
from .retry import is_transient

logger = logging.getLogger(__name__)
_log = _error_logger(__name__)

#: Artefacts the pipeline owns, in the order the sidebar should show them.
ARTIFACT_NAMES: tuple[str, ...] = ARTIFACT_PATHS

#: Which artefacts are worth sending with the orchestrator's prompts. Injecting every
#: artefact into every call was the largest avoidable input cost in a run.
_PHASE_CONTEXT: dict[Phase, tuple[str, ...]] = {
    Phase.PLAN: (),
    Phase.DESIGN: (PLAN_PATH,),
    Phase.BUILD: (PLAN_PATH,),
    Phase.TEST: (PLAN_PATH,),
    Phase.SYNC: (),
}

#: How much of each artefact the orchestrator may read when writing a brief.
_CONTEXT_READ_LIMIT = 2500

#: Cap on the workspace listing included in a brief — a large repository can list thousands
#: of entries and the model only needs to know what kind of project this is.
_CONTEXT_LISTING_LIMIT = 30

#: How much of the running discussion the orchestrator sees when writing a brief.
_DISCUSSION_MESSAGES = 8
_DISCUSSION_CLIP = 1200

#: How much of the tail of the transcript the orchestrator sees before judging.
_EVIDENCE_MESSAGES = 4
_EVIDENCE_CLIP = 600

#: Output ceiling for the orchestrator. Its replies are a short brief or a verdict. Kept
#: well above a realistic brief: a ceiling that truncates the instruction mid-sentence is
#: worse than none, and some gateways ignore the parameter entirely.
ORCHESTRATOR_MAX_TOKENS = 1200

#: Output ceiling for a discussion turn. A chat reply is not a document, and the default
#: specialist ceiling (``ORBITAL_LLM_MAX_TOKENS``, 8000) is sized for one: with it, a greeting
#: came back as a full proposed plan. The prompt is what makes replies conversational; this is
#: the backstop that keeps a runaway one from filling the pane.
#: Still generous, for the same reason as the orchestrator's: truncation is worse than length.
DISCUSSION_MAX_TOKENS = 1200

#: Upper bound on orchestrator↔specialist super-steps for one run.
RECURSION_LIMIT = 120

#: Retried nodes: a specialist whose stream dies mid-response resumes instead of losing the
#: whole phase. Three attempts with backoff covers the flaky-connection case without
#: hammering a genuinely broken endpoint.
RETRY_POLICY = RetryPolicy(
    max_attempts=3,
    initial_interval=1.0,
    backoff_factor=2.0,
    max_interval=15.0,
    retry_on=is_transient,
)

_SPECIALISTS: tuple[AgentId, ...] = (AgentId.ARCHITECT, AgentId.CODE_ENGINE, AgentId.QA)

_DECISIONS = ("ADVANCE", "RETRY", "STOP")
_DECISION_LINE = re.compile(r"DECISION:\s*(ADVANCE|RETRY|STOP)", re.IGNORECASE)
_SUMMARY_LINE = re.compile(r"SUMMARY:\s*(.+)", re.IGNORECASE)
_BARE_DECISION = re.compile(r"\b(ADVANCE|RETRY|STOP)\b")

Emitter = Callable[..., Awaitable[None]]


async def never_paused() -> None:
    """The step boundary of a run that cannot be paused: a context built without a gate."""
    return None


class StepBoundary(AgentMiddleware):
    """Holds a specialist at its next model or tool call while the run is paused.

    LangGraph runs the graph ahead of whoever is reading its event stream, so a pause enforced
    on the reader's side would let a paused run keep calling the model and running commands
    behind the user's back. The gate therefore sits where a step actually begins — both of the
    hooks below await the run's boundary before letting the step happen, which is what makes a
    pause mean "this run has stopped" rather than "its output is being withheld".

    The hook is awaited before the call rather than during it, so a paused run holds no provider
    connection and no running command: only its place in the graph.
    """

    def __init__(self, boundary: Callable[[], Awaitable[None]]) -> None:
        super().__init__()
        self._boundary = boundary

    async def awrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], Awaitable[ModelResponse[Any]]],
    ) -> ModelResponse[Any] | AIMessage:
        await self._boundary()
        return await handler(request)

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        await self._boundary()
        return await handler(request)


@dataclass(slots=True)
class RunContext:
    """Everything a node needs that is not part of the graph state."""

    session_id: str
    project_path: str
    prompt: str
    phase: Phase
    auto_advance: bool
    emit: Emitter
    bus: EventBus
    #: Model override for this run; ``None`` uses ORBITAL_LLM_MODEL.
    model: str | None = None
    #: The provider profile this run is pinned to, or ``None`` for the active one. Held as the
    #: resolved profile rather than its id so the whole run talks to one endpoint: a run that read
    #: the id back would follow the user's next activation halfway through its own phases.
    provider: ProviderProfile | None = None
    #: How hard every model this run builds should think. ``None`` sends no parameter at all,
    #: because a gateway that does not know it may refuse the request.
    reasoning_effort: str | None = None
    #: Prior conversation, replayed so a confirmed plan is written from what was discussed.
    transcript: tuple[AnyMessage, ...] = ()
    #: The capabilities the user enabled for this run, or ``None`` for no restriction. Narrows
    #: every tool set the graph builds (see ``tools.tools_for``).
    capabilities: list[str] | None = None
    #: The composer's approval mode, applied to the session before the turn starts so the first
    #: command already sees it.
    permission: Permission | None = None
    #: Awaited before every model call and every tool call this run makes: the run's pause gate.
    #: The runner injects it; a context built without one (a test, a tool) simply never pauses.
    step_boundary: Callable[[], Awaitable[None]] = never_paused

    @property
    def root(self) -> Path:
        return Path(self.project_path)


class OrbitalState(TypedDict, total=False):
    """Graph state. ``messages`` accumulates across all specialists via ``add_messages``."""

    session_id: str
    prompt: str
    phase: str
    stage: Literal["pre", "post", "done"]
    directive: str
    verdict: str
    summary: str
    attempts: int
    next_agent: str
    messages: Annotated[list[AnyMessage], add_messages]


# -------------------------------------------------------------------------------------
# Message helpers
# -------------------------------------------------------------------------------------


def message_text(message: AnyMessage) -> str:
    """Extract plain text from a message whose content may be a string or content blocks."""
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "".join(parts)
    return ""


def parse_verdict(text: str) -> tuple[str, str]:
    """Read the orchestrator's verdict, falling back to the first bare keyword."""
    match = _DECISION_LINE.search(text)
    decision = match.group(1).upper() if match else ""
    if not decision:
        bare = _BARE_DECISION.search(text)
        decision = bare.group(1).upper() if bare else "ADVANCE"
    summary_match = _SUMMARY_LINE.search(text)
    summary = summary_match.group(1).strip() if summary_match else ""
    if not summary:
        # Keep the verdict readable in the UI even when the model ignores the format.
        body = _DECISION_LINE.sub("", text)
        body = _SUMMARY_LINE.sub("", body).strip()
        summary = body[:400]
    return decision, summary


def _discussion(state: OrbitalState) -> str:
    """The conversation so far, so a brief builds on what was agreed instead of inventing it.

    Without this the orchestrator filled the gap with a plausible-looking stack nobody had
    chosen, and the specialist then had to spend its turn resolving the contradiction.
    """
    lines: list[str] = []
    for message in (state.get("messages") or [])[-_DISCUSSION_MESSAGES:]:
        if getattr(message, "type", "") == "tool":
            continue
        text = message_text(message).strip()
        if text:
            lines.append(f"[{getattr(message, 'type', 'message')}] {text[:_DISCUSSION_CLIP]}")
    return "\n\n".join(lines)


def _evidence(state: OrbitalState) -> str:
    """The tail of the transcript, used as the orchestrator's evidence for its verdict."""
    messages = list(state.get("messages") or [])
    lines: list[str] = []
    for message in messages[-_EVIDENCE_MESSAGES:]:
        kind = getattr(message, "type", "message")
        text = message_text(message).strip()
        lines.append(f"[{kind}] {text[:_EVIDENCE_CLIP] if text else '(no text)'}")
    return "\n\n".join(lines) or "(the specialist produced no messages)"


def _project_context(root: Path, phase: Phase) -> str:
    """A compact digest of the workspace: the artefacts this phase needs, plus the listing.

    Only what the phase actually consumes is sent: the full ``plan.md`` is useful when
    designing or building, and pure overhead when syncing to git.
    """
    parts: list[str] = []
    for name in _PHASE_CONTEXT[phase]:
        target = root / name
        try:
            if not target.is_file():
                continue
            text = target.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            parts.append(f"### {name}\n(unreadable: {exc})")
            continue
        clipped = text[:_CONTEXT_READ_LIMIT]
        if len(text) > _CONTEXT_READ_LIMIT:
            clipped += f"\n... [truncated, {len(text)} characters total]"
        parts.append(f"### {name}\n{clipped}")
    try:
        entries = sorted(
            f"{entry.name}{'/' if entry.is_dir() else ''}" for entry in root.iterdir()
        )
    except OSError as exc:
        entries = [f"(unreadable: {exc})"]
    listing = ", ".join(entries[:_CONTEXT_LISTING_LIMIT]) if entries else "(empty workspace)"
    parts.append(f"### workspace root listing\n{listing}")

    # The design mocks are HTML documents, so naming them is useful and sending their contents is
    # not — the specialist can read the one it needs with read_file.
    design_dir = root / DESIGN_DIR
    if design_dir.is_dir():
        mocks = sorted(path.name for path in design_dir.glob("*.html"))
        if mocks:
            parts.append(f"### design mocks in {DESIGN_DIR}/\n" + ", ".join(mocks[:40]))

    # A project may be bound to a repository and a branch model. Both phases that touch git need
    # to know, and the ones that do not are not harmed by a paragraph they will not act on.
    entry = projects.find_by_path(root)
    if entry is not None and entry.repository and entry.branch_strategy:
        parts.append(repository_block(entry.repository, entry.branch_strategy))

    return "\n\n".join(parts)


def _fallback_brief(phase: Phase, prompt: str) -> str:
    """A deterministic brief for when the model returns nothing usable.

    A provider can answer a briefing call with an empty completion (reasoning-only output,
    or a truncated one). The old fallback was a bare "Complete phase design.", which told the
    specialist nothing and burned the phase — so the brief is rebuilt from the phase spec
    instead, which is all the specialist actually needs.
    """
    spec = PHASE_SPEC_BY_ID[phase]
    return "\n".join(
        [
            f"Deliverable: `{spec.deliverable}` — {spec.title}.",
            spec.description,
            "",
            f"User request: {prompt}",
            "",
            "Read what already exists in the workspace first, then produce the deliverable as "
            "a file before reporting.",
        ]
    )


async def _announce(
    ctx: RunContext,
    *,
    agent: AgentId,
    phase: Phase | None,
    content: str,
) -> str:
    """Record an agent message in session state and emit its start/end frames.

    Used by the orchestrator, whose turns are short and atomic. Specialists stream
    token-by-token instead (see ``agents.runner``).
    """
    message_id = uuid4().hex
    sessions.add_message(
        ctx.session_id,
        ChatMessage(
            id=message_id,
            role=MessageRole.ASSISTANT,
            agent=agent,
            content=content,
            phase=phase,
            created_at=int(time.time() * 1000),
            streaming=False,
        ),
    )
    await ctx.emit(
        "agent.message.start",
        {"messageId": message_id, "agent": agent.value, "phase": phase.value if phase else None},
        session_id=ctx.session_id,
    )
    await ctx.emit(
        "agent.message.end",
        {"messageId": message_id, "content": content},
        session_id=ctx.session_id,
    )
    return message_id


# -------------------------------------------------------------------------------------
# Graph construction
# -------------------------------------------------------------------------------------


def _tool_context(ctx: RunContext, agent: AgentId) -> ToolContext:
    """The workspace/bus handle a tool needs, for one agent in one run."""
    return ToolContext(
        session_id=ctx.session_id,
        agent=agent,
        root=ctx.root,
        emit=ctx.emit,
        bus=bus,
        phase=ctx.phase,
        approve=_approval_gate(ctx, agent),
    )


def _tools_for(ctx: RunContext, agent: AgentId) -> list[BaseTool]:
    """The agent's tools, narrowed by the capabilities the user enabled for this run."""
    return apply_capabilities(tools_for(agent, _tool_context(ctx, agent)), ctx.capabilities)


def _approval_gate(
    ctx: RunContext, agent: AgentId
) -> Callable[[str, str, str], Awaitable[bool]]:
    """Build the ask-the-user hook a shell tool calls before running anything.

    The request carries the phase and agent so the card in the chat can say who wants what, and
    the id is the tool-call id, which is what pairs the card with the inspector row.
    """

    async def approve(request_id: str, command: str, cwd: str) -> bool:
        allowed = await approvals.request(
            ctx.session_id,
            CommandRequest(
                id=request_id,
                agent=agent,
                phase=ctx.phase,
                command=command,
                cwd=cwd,
                tool="run_command",
            ),
        )
        if not allowed:
            _log.info("command refused for session %s: %s", ctx.session_id, command[:120])
        return allowed

    return approve


#: Tools withheld during a discussion turn. Writing is *not* withheld: the deliverable is the
#: conversation's product — the architect writes the plan (or the mocks) once it has heard enough
#: and revises it when asked — and a chat agent that cannot touch a file can only describe the work.
#: Deleting stays out, because nothing in a conversation needs to remove anything.
CHAT_EXCLUDED_TOOLS = frozenset({"delete_file"})


def build_chat_agent(ctx: RunContext) -> Any:
    """The conversational counterpart to the supervisor: one specialist, no verdict.

    Used by the plan and design phases, where the deliverable is worked out by talking. The
    specialist keeps its ordinary tools — including the ones that write the deliverable — and the
    discussion rules tell it when to use them, because a plan the agent cannot write down is a plan
    the user has to transcribe.
    """
    model = build_llm(
        session_id=ctx.session_id,
        max_tokens=DISCUSSION_MAX_TOKENS,
        model=ctx.model,
        reasoning_effort=ctx.reasoning_effort,
        profile=ctx.provider,
    )
    tools = [t for t in _tools_for(ctx, AgentId.ARCHITECT) if t.name not in CHAT_EXCLUDED_TOOLS]
    return create_agent(
        model,
        tools=tools,
        system_prompt=(
            SPECIALIST_PROMPTS[AgentId.ARCHITECT]
            + DISCUSSION_RULES
            + environment_block(ctx.root)
        ),
        middleware=[StepBoundary(ctx.step_boundary)],
        name="architect_discussion",
    )


def build_graph(ctx: RunContext) -> Any:
    """Compile the supervisor graph for one run of one session."""
    # Two clients so each role gets its own output ceiling: the orchestrator only ever
    # writes a short brief or a verdict, while a specialist may legitimately write a whole
    # document into a file.
    orchestrator_model = build_llm(
        session_id=ctx.session_id,
        max_tokens=ORCHESTRATOR_MAX_TOKENS,
        model=ctx.model,
        reasoning_effort=ctx.reasoning_effort,
        profile=ctx.provider,
    )
    specialist_model = build_llm(
        session_id=ctx.session_id,
        model=ctx.model,
        reasoning_effort=ctx.reasoning_effort,
        profile=ctx.provider,
    )

    async def orchestrate_brief(state: OrbitalState, phase: Phase) -> dict[str, Any]:
        spec = PHASE_SPEC_BY_ID[phase]
        agent = PHASE_AGENT[phase]
        human = "\n".join(
            [
                f"PHASE: {phase.value} — {spec.title}",
                f"DELIVERABLE: {spec.deliverable}",
                f"SPECIALIST: {agent.value}",
                f"ATTEMPT: {int(state.get('attempts') or 0) + 1}",
                f"USER PROMPT: {state.get('prompt') or ctx.prompt}",
                "",
                "## Agreed so far (authoritative — do not contradict it)",
                _discussion(state) or "(nothing yet)",
                "",
                "## Project context",
                _project_context(ctx.root, phase),
            ]
        )
        if state.get("verdict") == "RETRY" and state.get("summary"):
            human += f"\n\n## Why the previous attempt was rejected\n{state['summary']}"

        reply = await orchestrator_model.ainvoke(
            [SystemMessage(ORCHESTRATOR_BRIEF), HumanMessage(human)]
        )
        brief = message_text(reply).strip() or _fallback_brief(phase, state.get("prompt") or ctx.prompt)
        await _announce(ctx, agent=AgentId.ORCHESTRATOR, phase=phase, content=brief)
        return {
            "directive": brief,
            "stage": "post",
            "verdict": "",
            "next_agent": agent.value,
            "messages": [HumanMessage(f"PHASE: {phase.value}\n\n{brief}")],
        }

    async def orchestrate_verdict(state: OrbitalState, phase: Phase) -> dict[str, Any]:
        spec = PHASE_SPEC_BY_ID[phase]
        attempts = int(state.get("attempts") or 0)
        deliverable_note = ""
        if spec.deliverable.endswith(".md"):
            exists = (ctx.root / spec.deliverable).is_file()
            deliverable_note = (
                f"The deliverable file {spec.deliverable!r} "
                f"{'exists' if exists else 'does not exist'} in the workspace root."
            )
        human = "\n".join(
            [
                f"PHASE: {phase.value} — {spec.title}",
                f"DELIVERABLE: {spec.deliverable}",
                f"ATTEMPT: {attempts + 1}",
                deliverable_note,
                "",
                "## Evidence from the transcript",
                _evidence(state),
            ]
        )
        reply = await orchestrator_model.ainvoke(
            [SystemMessage(ORCHESTRATOR_VERDICT), HumanMessage(human)]
        )
        raw = message_text(reply)
        decision, summary = parse_verdict(raw)
        await _announce(
            ctx,
            agent=AgentId.ORCHESTRATOR,
            phase=phase,
            content=f"**{decision}** — {summary}" if summary else f"**{decision}**",
        )

        if decision == "RETRY" and attempts >= 1:
            # One retry is allowed; a second failure ends the phase so a run cannot spin.
            decision = "STOP"
            summary = f"{summary}\n\nStopping: {phase.value} already used its single retry.".strip()

        if decision == "STOP":
            return {"stage": "done", "verdict": "STOP", "summary": summary, "next_agent": END}

        if decision == "RETRY":
            return {
                "stage": "pre",
                "verdict": "RETRY",
                "summary": summary,
                "attempts": attempts + 1,
                "next_agent": "orchestrator",
            }

        following = next_phase(phase) if ctx.auto_advance else None
        if following is None:
            return {"stage": "done", "verdict": "ADVANCE", "summary": summary, "next_agent": END}
        return {
            "phase": following.value,
            "stage": "pre",
            "verdict": "ADVANCE",
            "summary": summary,
            "attempts": 0,
            "next_agent": "orchestrator",
        }

    async def orchestrator(state: OrbitalState) -> dict[str, Any]:
        # The node's first act is a model call, so its step boundary is here: a pause that
        # arrived while the specialist was working stops the run before the verdict is asked for.
        await ctx.step_boundary()
        phase = Phase(state.get("phase") or ctx.phase.value)
        if state.get("stage") == "post":
            return await orchestrate_verdict(state, phase)
        return await orchestrate_brief(state, phase)

    def route(state: OrbitalState) -> str:
        return state.get("next_agent") or END

    builder = StateGraph(OrbitalState)
    # Both node kinds are retried: a stream that dies mid-response is a transport failure,
    # not a wrong answer, and re-running the node is far cheaper than losing the phase.
    builder.add_node("orchestrator", orchestrator, retry_policy=RETRY_POLICY)
    for agent in _SPECIALISTS:
        builder.add_node(
            agent.value,
            create_agent(
                specialist_model,
                tools=_tools_for(ctx, agent),
                # The environment is appended per run: the same prompt on a different machine
                # has to describe a different shell.
                system_prompt=SPECIALIST_PROMPTS[agent] + environment_block(ctx.root),
                middleware=[StepBoundary(ctx.step_boundary)],
                name=agent.value,
            ),
            retry_policy=RETRY_POLICY,
        )
    builder.add_edge(START, "orchestrator")
    builder.add_conditional_edges(
        "orchestrator",
        route,
        {agent.value: agent.value for agent in _SPECIALISTS}
        | {"orchestrator": "orchestrator", END: END},
    )
    for agent in _SPECIALISTS:
        builder.add_edge(agent.value, "orchestrator")
    return builder.compile()
