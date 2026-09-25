"""Tests for the LangGraph supervisor, its event translation, and the run driver.

These run against the real compiled graph with a scripted chat model, so the supervisor's
phase routing, the specialist ReAct loop, tool-call wiring and the session bookkeeping are
all exercised without touching the network.
"""

from __future__ import annotations

import json
import platform
from types import SimpleNamespace
from typing import Annotated, Any, AsyncIterator

import httpx
import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import InjectedToolCallId, tool

from orbital_backend.agents import graph as graph_module
from orbital_backend.agents import runner as runner_module
from orbital_backend.agents.graph import RunContext, build_graph, parse_verdict
from orbital_backend.agents.runner import FAILURE_TEXT_LIMIT, _Tracker, describe_failure
from orbital_backend.config import settings
from orbital_backend.events import bus
from orbital_backend.models import Phase, PhaseStatus, RunStatus
from orbital_backend.services.sessions import sessions
from orbital_backend.services.workspace import workspace
from orbital_backend.tools.context import ToolContext, run_tool

VERDICT = "DECISION: ADVANCE\nREASON: the deliverable matches the brief\nSUMMARY: phase complete"


class ScriptedModel(BaseChatModel):
    """Chat model that streams canned replies.

    ``replies[i]`` answers the i-th model call, clamped to the last entry. The scripted
    order for a full run is: orchestrator brief, specialist turn, orchestrator verdict,
    then the same three for every following phase.
    """

    replies: list[str] = [
        "Write plan.md describing the requirement and the stack.",
        "Draft the plan, then stop.",
        VERDICT,
    ]
    calls: int = 0

    @property
    def _llm_type(self) -> str:
        return "orbital-scripted"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ScriptedModel":
        return self

    def _reply(self) -> str:
        index = min(self.calls, len(self.replies) - 1)
        self.calls += 1
        return self.replies[index]

    def _generate(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=self._reply()))])

    async def _astream(
        self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any
    ) -> AsyncIterator[ChatGenerationChunk]:
        for token in self._reply().split(" "):
            yield ChatGenerationChunk(message=AIMessageChunk(content=f"{token} "))


class ToolCallingModel(ScriptedModel):
    """Specialist that asks for one tool on its first turn, then answers in prose.

    Keyed off ``bind_tools`` rather than call order: the graph builds one model per role, so
    a specialist starts its own call count and an orchestrator model never has tools bound.
    """

    tools_bound: bool = False

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ToolCallingModel":
        self.tools_bound = True
        return self

    def _wants_a_tool(self) -> bool:
        return self.tools_bound and self.calls == 0

    def _tool_call(self) -> AIMessage:
        return AIMessage(
            content="",
            tool_calls=[{"name": "echo_note", "args": {"text": "hello"}, "id": "call-1"}],
        )

    def _generate(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        if self._wants_a_tool():
            self.calls += 1
            return ChatResult(generations=[ChatGeneration(message=self._tool_call())])
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=self._reply()))])

    async def _astream(
        self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any
    ) -> AsyncIterator[ChatGenerationChunk]:
        if self._wants_a_tool():
            self.calls += 1
            call = self._tool_call()
            yield ChatGenerationChunk(message=AIMessageChunk(content="", tool_calls=call.tool_calls))
            return
        for token in self._reply().split(" "):
            yield ChatGenerationChunk(message=AIMessageChunk(content=f"{token} "))


class DroppedStreamModel(ScriptedModel):
    """Fails the first turn the way a dropped connection does, then behaves normally."""

    remaining_failures: int = 1

    def _reply(self) -> str:
        if self.remaining_failures > 0:
            self.remaining_failures -= 1
            raise ConnectionAbortedError(
                "[WinError 1236] The network connection was aborted by the local system"
            )
        return super()._reply()


class SilentModel(ScriptedModel):
    """Answers every call with whitespace, the way a reasoning-only reply arrives."""

    replies: list[str] = [" "]


class PermanentlyBrokenModel(ScriptedModel):
    """A deterministic failure that retrying cannot fix."""

    def _reply(self) -> str:
        raise ValueError("the brief could not be rendered")


class FrameRecorder:
    """Captures emitted frames in place of a connected socket."""

    def __init__(self) -> None:
        self.frames: list[dict[str, Any]] = []

    async def __call__(self, type_: str, payload: Any, *, session_id: str | None = None) -> None:
        self.frames.append({"type": type_, "payload": payload, "sessionId": session_id})

    def types(self) -> list[str]:
        return [frame["type"] for frame in self.frames]

    def of(self, type_: str) -> list[dict[str, Any]]:
        return [frame for frame in self.frames if frame["type"] == type_]


def _tool_for(ctx: ToolContext):
    """A minimal real tool: goes through ``run_tool`` so it emits call+result frames."""

    @tool
    async def echo_note(text: str, tool_call_id: Annotated[str, InjectedToolCallId] = "") -> str:
        """Write a short note into the workspace."""

        async def invoke() -> str:
            target = ctx.root / "note.txt"
            target.write_text(text, encoding="utf-8")
            return f"OK: wrote {len(text)} bytes to {target.name}"

        return await run_tool(ctx, "echo_note", tool_call_id, {"text": text}, invoke)

    return echo_note


async def _stream_graph(
    ctx: RunContext, session_id: str, prompt: str, phase: Phase
) -> _Tracker:
    tracker = _Tracker(session_id=session_id, phase=phase, root=ctx.root)
    initial = {
        "session_id": session_id,
        "prompt": prompt,
        "phase": phase.value,
        "stage": "pre",
        "attempts": 0,
        "next_agent": "orchestrator",
        "messages": [],
    }
    graph = build_graph(ctx)
    stream = graph.astream(
        initial,
        {"recursion_limit": 60},
        stream_mode=["messages", "updates"],
        subgraphs=True,
    )
    async for item in stream:
        await tracker.handle(item)
    await tracker.close_all()
    return tracker


# -------------------------------------------------------------------------------------
# Verdict parsing
# -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "decision"),
    [
        ("DECISION: ADVANCE\nREASON: done\nSUMMARY: ok", "ADVANCE"),
        ("decision: retry\nREASON: plan.md missing\nSUMMARY: retry", "RETRY"),
        ("DECISION: STOP\nREASON: needs credentials\nSUMMARY: blocked", "STOP"),
        ("I think we should STOP here because credentials are missing.", "STOP"),
        ("No keyword at all", "ADVANCE"),
    ],
)
def test_parse_verdict_reads_the_decision(text: str, decision: str) -> None:
    assert parse_verdict(text)[0] == decision


def test_parse_verdict_extracts_the_summary() -> None:
    _, summary = parse_verdict(VERDICT)
    assert summary == "phase complete"


# -------------------------------------------------------------------------------------
# Graph behaviour
# -------------------------------------------------------------------------------------


async def test_auto_advance_walks_every_phase(monkeypatch: pytest.MonkeyPatch, sample_project) -> None:
    monkeypatch.setattr(graph_module, "build_llm", lambda **_kwargs: ScriptedModel())
    monkeypatch.setattr(graph_module, "tools_for", lambda agent, ctx: [])

    session_id = "test-five-phases"
    sessions.reset(session_id)
    sessions.set_project_path(session_id, str(sample_project))

    ctx = RunContext(
        session_id=session_id,
        project_path=str(sample_project),
        prompt="build a note-taking app",
        phase=Phase.PLAN,
        auto_advance=True,
        emit=bus.emit,
        bus=bus,
    )
    tracker = await _stream_graph(ctx, session_id, "build a note-taking app", Phase.PLAN)

    assert tracker.phase is Phase.SYNC
    assert tracker.verdict == "ADVANCE"
    assert tracker.tool_calls == 0

    state = sessions.get(session_id)
    for phase in (Phase.PLAN, Phase.DESIGN, Phase.BUILD, Phase.TEST):
        assert state.phases[phase] is PhaseStatus.DONE, phase
    # The final phase is never left behind, so it stays running for the caller to settle.
    assert state.phases[Phase.SYNC] is PhaseStatus.RUNNING
    assert state.messages, "the orchestrator should have spoken"


async def test_without_auto_advance_only_the_requested_phase_runs(
    monkeypatch: pytest.MonkeyPatch, sample_project
) -> None:
    monkeypatch.setattr(graph_module, "build_llm", lambda **_kwargs: ScriptedModel())
    monkeypatch.setattr(graph_module, "tools_for", lambda agent, ctx: [])

    session_id = "test-single-phase"
    sessions.reset(session_id)
    ctx = RunContext(
        session_id=session_id,
        project_path=str(sample_project),
        prompt="plan it",
        phase=Phase.PLAN,
        auto_advance=False,
        emit=bus.emit,
        bus=bus,
    )
    tracker = await _stream_graph(ctx, session_id, "plan it", Phase.PLAN)

    assert tracker.phase is Phase.PLAN
    assert sessions.get(session_id).phases[Phase.DESIGN] is PhaseStatus.IDLE


async def test_specialist_tool_calls_are_reported_with_matching_ids(
    monkeypatch: pytest.MonkeyPatch, sample_project
) -> None:
    recorder = FrameRecorder()
    monkeypatch.setattr(graph_module, "build_llm", lambda **_kwargs: ToolCallingModel())
    monkeypatch.setattr(
        graph_module,
        "tools_for",
        lambda agent, ctx: [_tool_for(ctx)],
    )
    monkeypatch.setattr(bus, "emit", recorder)

    session_id = "test-tool-call"
    sessions.reset(session_id)
    ctx = RunContext(
        session_id=session_id,
        project_path=str(sample_project),
        prompt="write the plan",
        phase=Phase.PLAN,
        auto_advance=False,
        emit=bus.emit,
        bus=bus,
    )
    tracker = await _stream_graph(ctx, session_id, "write the plan", Phase.PLAN)

    calls = recorder.of("agent.tool_call")
    results = recorder.of("agent.tool_result")
    assert len(calls) == 1, recorder.types()
    assert len(results) == 1
    assert calls[0]["payload"].name == "echo_note"
    assert calls[0]["payload"].args == {"text": "hello"}
    assert calls[0]["payload"].id == results[0]["payload"].id
    assert results[0]["payload"].ok is True
    assert tracker.tool_calls == 1
    assert (sample_project / "note.txt").read_text(encoding="utf-8") == "hello"


# -------------------------------------------------------------------------------------
# Run driver
# -------------------------------------------------------------------------------------


async def test_start_run_without_api_key_settles_the_session_in_error(
    monkeypatch: pytest.MonkeyPatch, sample_project
) -> None:
    recorder = FrameRecorder()
    monkeypatch.setattr(bus, "emit", recorder)
    monkeypatch.setattr(settings, "llm_api_key", "")

    session_id = "test-no-key"
    sessions.reset(session_id)
    await runner_module.start_run(session_id, Phase.PLAN, "do a thing", str(sample_project), False)

    state = sessions.get(session_id)
    assert state.status is RunStatus.ERROR
    assert "ORBITAL_LLM_API_KEY" in (state.error or "")
    errors = recorder.of("agent.error")
    assert errors and "ORBITAL_LLM_API_KEY" in errors[0]["payload"]["message"]
    assert recorder.of("agent.done")


async def test_start_run_on_a_missing_folder_reports_a_workspace_error(
    monkeypatch: pytest.MonkeyPatch, sample_project
) -> None:
    recorder = FrameRecorder()
    monkeypatch.setattr(bus, "emit", recorder)
    monkeypatch.setattr(settings, "llm_api_key", "sk-test-not-real")

    session_id = "test-missing-folder"
    sessions.reset(session_id)
    missing = sample_project / "does-not-exist"
    await runner_module.start_run(session_id, Phase.PLAN, "do a thing", str(missing), False)

    state = sessions.get(session_id)
    assert state.status is RunStatus.ERROR
    assert "does not exist" in (state.error or "")


# -------------------------------------------------------------------------------------
# Transient transport failures
# -------------------------------------------------------------------------------------


async def test_a_dropped_stream_is_retried(
    monkeypatch: pytest.MonkeyPatch, sample_project
) -> None:
    """The failure users actually hit: WinError 1236 part-way through a response.

    ``max_retries`` on the client cannot cover it — the stream had already started — so the
    node's retry policy has to.
    """
    monkeypatch.setattr(bus, "emit", FrameRecorder())
    monkeypatch.setattr(settings, "llm_api_key", "sk-test-not-real")
    flaky = DroppedStreamModel()
    monkeypatch.setattr(graph_module, "build_llm", lambda **_kwargs: flaky)
    monkeypatch.setattr(graph_module, "tools_for", lambda agent, ctx: [])

    session_id = "test-dropped-stream"
    sessions.reset(session_id)
    await runner_module.start_run(session_id, Phase.PLAN, "plan it", str(sample_project), False)

    state = sessions.get(session_id)
    assert state.status is RunStatus.DONE, f"the run did not recover: {state.error}"
    assert flaky.remaining_failures == 0, "the injected failure never fired"


async def test_an_empty_reply_still_briefs_the_specialist(
    monkeypatch: pytest.MonkeyPatch, sample_project
) -> None:
    """A provider can answer a briefing call with nothing.

    The old fallback was "Complete phase design." — a content-free instruction that wasted
    the phase. The brief must be rebuilt from the phase spec instead.
    """
    monkeypatch.setattr(bus, "emit", FrameRecorder())
    monkeypatch.setattr(settings, "llm_api_key", "sk-test-not-real")
    monkeypatch.setattr(graph_module, "build_llm", lambda **_kwargs: SilentModel())
    monkeypatch.setattr(graph_module, "tools_for", lambda agent, ctx: [])

    session_id = "test-silent-brief"
    sessions.reset(session_id)
    await runner_module.start_run(session_id, Phase.PLAN, "plan it", str(sample_project), False)

    contents = [message.content for message in sessions.get(session_id).messages]
    assert any(
        "plan.md" in body and "Planning & Research" in body for body in contents
    ), f"no usable brief was produced: {contents[:3]}"


async def test_a_permanent_failure_is_not_retried(
    monkeypatch: pytest.MonkeyPatch, sample_project
) -> None:
    monkeypatch.setattr(bus, "emit", FrameRecorder())
    monkeypatch.setattr(settings, "llm_api_key", "sk-test-not-real")
    monkeypatch.setattr(graph_module, "build_llm", lambda **_kwargs: PermanentlyBrokenModel())
    monkeypatch.setattr(graph_module, "tools_for", lambda agent, ctx: [])

    session_id = "test-permanent-failure"
    sessions.reset(session_id)
    await runner_module.start_run(session_id, Phase.PLAN, "plan it", str(sample_project), False)

    error = sessions.get(session_id).error or ""
    assert "ValueError" in error
    assert "dropped mid-response" not in error, "a deterministic bug must not be blamed on the network"


def test_the_brief_sees_the_discussion() -> None:
    """The orchestrator invented a stack when it had no context to work from.

    The plan phase seeds the agreed conversation into the run, and the brief has to carry it so
    the specialist is not handed a fabricated stack to reconcile.
    """
    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

    from orbital_backend.agents.graph import _discussion

    state = {
        "messages": [
            HumanMessage("Python 3, standard library only."),
            AIMessage("Agreed — one module plus one test file."),
            ToolMessage("OK: 12 files", tool_call_id="c1"),
        ]
    }

    digest = _discussion(state)

    assert "Python 3, standard library only." in digest
    assert "one module plus one test file" in digest
    assert "12 files" not in digest, "tool traffic is noise in a brief"


def test_environment_block_describes_the_real_shell() -> None:
    """The build phase used `head` on Windows and lost the phase.

    The prompt has to name the shell ``run_command`` actually uses and the utilities that
    exist on this platform, or the agent guesses POSIX and burns a turn on exit 255.
    """
    from pathlib import Path

    from orbital_backend.agents.prompts import environment_block

    workspace = Path("C:/workspace/demo")
    block = environment_block(workspace)

    assert str(workspace) in block
    assert "run_command" in block
    if platform.system() == "Windows":
        assert "cmd.exe /C" in block
        assert "findstr" in block
        # The POSIX list must not appear at all on Windows, or it reads as an endorsement.
        assert "grep" not in block
    else:
        assert "/bin/sh -c" in block
        assert "`grep`" in block


def test_specialist_prompts_carry_the_shell_discipline() -> None:
    from orbital_backend.agents.prompts import SPECIALIST_PROMPTS

    for prompt in SPECIALIST_PROMPTS.values():
        assert "Shell discipline" in prompt
        assert "head" in prompt


def test_is_transient_walks_the_exception_chain() -> None:
    """The real failure arrives as ReadError wrapping ConnectionAbortedError."""
    from orbital_backend.agents.retry import is_transient

    inner = ConnectionAbortedError("[WinError 1236] aborted by the local system")
    outer = RuntimeError("stream failed")
    outer.__cause__ = inner

    assert is_transient(outer) is True
    assert is_transient(ValueError("bad prompt")) is False
    assert is_transient(_FakeStatusError(503, "upstream unavailable")) is True
    assert is_transient(_FakeStatusError(404, "not found")) is False


# -------------------------------------------------------------------------------------
# Gateway contract
# -------------------------------------------------------------------------------------


def test_build_llm_identifies_the_conversation(configured_llm: None) -> None:
    """OpenCode Go requires the conversation id — omitting it is a 400, not a warning."""
    from orbital_backend.agents.llm import SESSION_HEADER, USER_AGENT, build_llm

    model = build_llm(session_id="session-abc")

    assert model.default_headers[SESSION_HEADER] == "session-abc"
    assert model.default_headers["User-Agent"] == USER_AGENT


def test_build_llm_omits_an_absent_session(configured_llm: None) -> None:
    from orbital_backend.agents.llm import SESSION_HEADER, build_llm

    assert SESSION_HEADER not in build_llm().default_headers


# -------------------------------------------------------------------------------------
# Reasoning effort
# -------------------------------------------------------------------------------------


def test_the_effort_reaches_every_model_only_when_set(
    sample_project: Path, configured_llm: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A run builds three models — the orchestrator, the specialists, and (for a discussion) the
    chat agent — and every one of them has to hear the same setting."""
    from orbital_backend.agents import graph as graph_module
    from orbital_backend.agents.graph import build_chat_agent

    seen: list[str | None] = []
    real_build_llm = graph_module.build_llm

    def recording_llm(**kwargs: object) -> object:
        seen.append(kwargs.get("reasoning_effort"))  # type: ignore[arg-type]
        return real_build_llm(**kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(graph_module, "build_llm", recording_llm)

    def context(effort: str | None) -> RunContext:
        return RunContext(
            session_id="test-effort",
            project_path=str(sample_project),
            prompt="plan it",
            phase=Phase.PLAN,
            auto_advance=False,
            emit=bus.emit,
            bus=bus,
            reasoning_effort=effort,
        )

    build_graph(context("high"))
    assert seen == ["high", "high"], "the orchestrator and the specialist both get it"

    seen.clear()
    build_graph(context(None))
    assert seen == [None, None]

    seen.clear()
    build_chat_agent(context("low"))
    assert seen == ["low"]


async def test_the_effort_is_on_the_wire_only_when_it_is_set(
    configured_llm: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A gateway that does not know ``reasoning_effort`` answers a request carrying it with an
    error, so unset has to mean absent from the body rather than null."""
    from orbital_backend.agents import llm as llm_module
    from orbital_backend.agents.llm import build_llm

    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "1",
                "object": "chat.completion",
                "created": 0,
                "model": "test",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "hi"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    real_chat_model = llm_module.ChatOpenAI
    monkeypatch.setattr(
        llm_module,
        "ChatOpenAI",
        lambda **kwargs: real_chat_model(**kwargs, http_async_client=client),
    )
    try:
        await build_llm(reasoning_effort="high").ainvoke("hello")
        await build_llm().ainvoke("hello")
    finally:
        await client.aclose()

    assert bodies[0]["reasoning_effort"] == "high"
    assert "reasoning_effort" not in bodies[1], "unset must not be sent as null"


@pytest.mark.parametrize("transport", ["run", "chat"])
async def test_an_unknown_reasoning_effort_is_refused(
    sample_project: Path, transport: str
) -> None:
    """Never silently ignored: an effort no gateway knows comes back as a refusal the caller can
    read — the socket renders this ``OrbitalError`` as an error frame, REST as a 400."""
    from orbital_backend.errors import OrbitalError
    from orbital_backend.routes.agents import chat_phase, run_phase

    with pytest.raises(OrbitalError) as caught:
        if transport == "run":
            await run_phase(
                "test-bad-effort",
                Phase.PLAN,
                "plan it",
                str(sample_project),
                False,
                reasoning_effort="ultra",
            )
        else:
            await chat_phase(
                "test-bad-effort",
                Phase.PLAN,
                "hello",
                str(sample_project),
                reasoning_effort="ultra",
            )

    assert "ultra" in caught.value.detail


@pytest.mark.parametrize(
    ("configured", "expected"),
    [
        ("https://opencode.ai/zen/go/v1", "https://opencode.ai/zen/go/v1"),
        ("https://opencode.ai/zen/go/v1/", "https://opencode.ai/zen/go/v1"),
        ("https://opencode.ai/zen/go/v1/chat/completions", "https://opencode.ai/zen/go/v1"),
        ("  https://example.test/v1/chat/completions  ", "https://example.test/v1"),
    ],
)
def test_endpoint_base_tolerates_a_pasted_full_endpoint(configured: str, expected: str) -> None:
    """The gateway docs publish full endpoints, so that is what gets pasted."""
    from orbital_backend.agents.llm import endpoint_base

    assert endpoint_base(configured) == expected


class _FakeResponse:
    def __init__(self, text: str, url: str) -> None:
        self.text = text
        self.request = SimpleNamespace(url=url)


class _FakeStatusError(Exception):
    def __init__(self, status: int, body: str, url: str = "") -> None:
        super().__init__(body)
        self.status_code = status
        self.response = _FakeResponse(body, url)


def test_describe_failure_condenses_an_html_error_page() -> None:
    """A misrouted gateway answers with a website, not an API error."""
    html = (
        "<!DOCTYPE html><html lang='en'><head><title>Not Found | opencode</title>"
        f"</head><body>{'markup ' * 4000}</body></html>"
    )

    message = describe_failure(
        _FakeStatusError(404, html, "https://opencode.ai/go/v1/chat/completions")
    )

    assert "HTTP 404" in message
    assert "Not Found | opencode" in message
    assert "ORBITAL_LLM_BASE_URL" in message
    assert "https://opencode.ai/go/v1/chat/completions" in message
    assert "<" not in message and "DOCTYPE" not in message
    assert len(message) <= FAILURE_TEXT_LIMIT + 1


def test_describe_failure_reads_a_json_error_envelope() -> None:
    body = (
        '{"type":"error","error":{"type":"MissingSessionID",'
        '"message":"Request is missing x-opencode-session"}}'
    )

    message = describe_failure(_FakeStatusError(400, body))

    assert message.startswith("HTTP 400")
    assert "missing x-opencode-session" in message


def test_describe_failure_points_at_the_key_when_rejected() -> None:
    message = describe_failure(
        _FakeStatusError(401, '{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}')
    )

    assert "Invalid API key." in message
    assert "ORBITAL_LLM_API_KEY" in message


def test_describe_failure_caps_a_plain_exception() -> None:
    message = describe_failure(RuntimeError("x" * 5000))

    assert message.startswith("RuntimeError")
    assert len(message) <= FAILURE_TEXT_LIMIT + 1


# -------------------------------------------------------------------------------------
# Gateway credential
# -------------------------------------------------------------------------------------


def _reset_credential(
    monkeypatch: pytest.MonkeyPatch, state: str = "unknown", detail: str | None = None
) -> None:
    """Start from a known verdict — the real one is per-process state."""
    from orbital_backend.agents import llm as llm_module

    monkeypatch.setattr(llm_module, "_credential_state", state, raising=False)
    monkeypatch.setattr(llm_module, "_credential_detail", detail, raising=False)


def test_is_credential_failure_separates_a_refusal_from_an_outage() -> None:
    """A refused key is never worth retrying; an unreachable gateway always is."""
    from orbital_backend.agents.retry import is_credential_failure

    outer = RuntimeError("model call failed")
    outer.__cause__ = _FakeStatusError(401, '{"error": {"message": "Invalid API key."}}')

    assert is_credential_failure(outer) is True
    assert is_credential_failure(_FakeStatusError(403, "forbidden")) is True
    assert is_credential_failure(_FakeStatusError(503, "upstream unavailable")) is False
    assert is_credential_failure(ConnectionResetError("reset by peer")) is False


def test_a_refused_key_is_reported_as_one_line_and_remembered(
    monkeypatch: pytest.MonkeyPatch, configured_llm: None
) -> None:
    """The user reads a remedy rather than a provider traceback, and the verdict survives."""
    from orbital_backend.agents.llm import credential_status
    from orbital_backend.agents.runner import _report_unexpected

    _reset_credential(monkeypatch)
    exc = _FakeStatusError(401, '{"error": {"message": "Invalid API key."}}')

    detail = _report_unexpected(exc, "discussion turn failed")
    state, stored = credential_status()

    assert "Invalid API key." in detail
    assert "Settings" in detail
    assert state == "rejected"
    assert "Invalid API key." in (stored or "")
    assert "Settings" not in (stored or ""), "the stored reason must not repeat the remedy"


def test_a_refused_key_is_never_refused_locally(
    monkeypatch: pytest.MonkeyPatch, configured_llm: None
) -> None:
    """A recorded refusal must not stop the next attempt.

    The verdict is a past observation and the key can be replaced at any moment, so a stale
    verdict must never block a turn that would succeed.
    """
    from orbital_backend.agents.llm import assert_llm_available

    _reset_credential(monkeypatch, "rejected", "HTTP 401 — Invalid API key.")

    assert_llm_available()


def test_a_working_call_clears_an_earlier_refusal(
    monkeypatch: pytest.MonkeyPatch, configured_llm: None
) -> None:
    """Whatever the settings row says must describe the key as it is now."""
    from orbital_backend.agents.llm import credential_status, note_credential

    _reset_credential(monkeypatch, "rejected", "HTTP 401 — Invalid API key.")

    note_credential("ok")

    assert credential_status() == ("ok", None)


def test_a_missing_key_keeps_its_own_message(
    monkeypatch: pytest.MonkeyPatch, configured_llm: None
) -> None:
    from orbital_backend.agents.llm import assert_llm_available
    from orbital_backend.errors import LLMNotConfigured

    _reset_credential(monkeypatch, "ok")
    monkeypatch.setattr(settings, "llm_api_key", "")

    with pytest.raises(LLMNotConfigured) as caught:
        assert_llm_available()

    assert "not set" in caught.value.detail


def test_a_discussion_turn_is_capped_where_a_document_is_not(
    sample_project: Path, configured_llm: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A chat reply is not a document, and its ceiling has to say so.

    With the specialist ceiling, a greeting came back as a full proposed plan with a file
    layout and a build order. The prompt is what makes a reply conversational; this cap is
    what keeps a runaway one out of the pane.
    """
    from orbital_backend.agents import graph as graph_module
    from orbital_backend.agents.graph import DISCUSSION_MAX_TOKENS, build_chat_agent

    ceilings: list[int | None] = []
    real_build_llm = graph_module.build_llm

    def recording_llm(**kwargs: object) -> object:
        ceilings.append(kwargs.get("max_tokens"))  # type: ignore[arg-type]
        return real_build_llm(**kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(graph_module, "build_llm", recording_llm)
    ctx = RunContext(
        session_id="test-chat-ceiling",
        project_path=str(sample_project),
        prompt="hey",
        phase=Phase.PLAN,
        auto_advance=False,
        emit=bus.emit,
        bus=bus,
    )

    build_chat_agent(ctx)

    assert ceilings == [DISCUSSION_MAX_TOKENS]


class PlanWritingModel(ScriptedModel):
    """The conversational architect: writes the plan on its first turn, then talks.

    This is the shape the real discussion turn has — it writes the deliverable as part of the
    conversation rather than only describing it.
    """

    tools_bound: bool = False

    def bind_tools(self, tools: Any, **kwargs: Any) -> "PlanWritingModel":
        self.tools_bound = True
        return self

    def _wants_to_write(self) -> bool:
        return self.tools_bound and self.calls == 0

    def _write_call(self) -> AIMessage:
        return AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "write_artifact",
                    "args": {"name": "plan.md", "content": "# Plan\n\n- one requirement\n"},
                    "id": "call-plan",
                }
            ],
        )

    def _generate(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        if self._wants_to_write():
            self.calls += 1
            return ChatResult(generations=[ChatGeneration(message=self._write_call())])
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=self._reply()))])

    async def _astream(
        self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any
    ) -> AsyncIterator[ChatGenerationChunk]:
        if self._wants_to_write():
            self.calls += 1
            call = self._write_call()
            yield ChatGenerationChunk(message=AIMessageChunk(content="", tool_calls=call.tool_calls))
            return
        for token in self._reply().split(" "):
            yield ChatGenerationChunk(message=AIMessageChunk(content=f"{token} "))


async def test_a_discussion_turn_can_write_the_plan(
    sample_project: Path, configured_llm: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The deliverable is the conversation's product.

    The plan is written by the architect while talking, not by a separate run afterwards, so a
    chat turn must be able to write it — and the file must land in `agent/` like any other
    artefact, not in the project root.
    """
    from orbital_backend.agents.graph import RECURSION_LIMIT, build_chat_agent

    workspace.set_root(sample_project)
    monkeypatch.setattr(graph_module, "build_llm", lambda **_kwargs: PlanWritingModel())
    ctx = RunContext(
        session_id="test-chat-writes-plan",
        project_path=str(sample_project),
        prompt="build me a todo app",
        phase=Phase.PLAN,
        auto_advance=False,
        emit=bus.emit,
        bus=bus,
    )

    agent = build_chat_agent(ctx)
    await agent.ainvoke(
        {"messages": [HumanMessage("build me a todo app")]},
        {"configurable": {"thread_id": "chat-writes"}, "recursion_limit": RECURSION_LIMIT},
    )

    written = sample_project / "agent" / "plan.md"
    assert written.is_file(), "the conversation must be able to produce the deliverable"
    assert written.read_text(encoding="utf-8").startswith("# Plan")
    assert not (sample_project / "plan.md").exists(), "artefacts live under agent/"
    # And it has to survive a reload: a plan written mid-conversation is state the socket resends,
    # not just a frame the open tab happened to catch.
    assert "agent/plan.md" in sessions.get("test-chat-writes-plan").artifacts


# -------------------------------------------------------------------------------------
# Attachments
# -------------------------------------------------------------------------------------


def test_a_chat_turn_stays_a_plain_message_until_something_is_attached(sample_project: Path) -> None:
    """Nothing attached leaves the ordinary turn exactly what it was; something attached becomes
    content parts, with the attachments before the user's own words."""
    from orbital_backend.agents.runner import _chat_message

    workspace.set_root(sample_project)
    (sample_project / "logo.png").write_bytes(b"\x89PNG" + b"0" * 32)

    plain = _chat_message(Phase.PLAN, "hey", None)
    assert isinstance(plain.content, str)
    assert plain.content == "PHASE: plan\n\nhey"

    attached = _chat_message(Phase.PLAN, "look at this", ["logo.png"])
    assert isinstance(attached.content, list)
    assert [part["type"] for part in attached.content] == ["text", "image_url", "text"]
    assert "logo.png" in attached.content[0]["text"]
    assert attached.content[-1]["text"] == "PHASE: plan\n\nlook at this"


async def test_a_run_hands_the_brief_the_attachment_block(
    sample_project: Path, configured_llm: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The run path appends the attachment block to the phase prompt — and still records what the
    user typed, not the block that was added to it."""
    from orbital_backend.agents.runner import _drive

    (sample_project / "notes.md").write_text("# Notes\n", encoding="utf-8")
    workspace.set_root(sample_project)
    captured: list[RunContext] = []

    class EmptyGraph:
        """Yields nothing: the point here is the context the run was built with."""

        async def astream(self, *_args: Any, **_kwargs: Any) -> AsyncIterator[Any]:
            if False:  # pragma: no cover - makes this an async generator
                yield None

    def capture(ctx: RunContext) -> Any:
        captured.append(ctx)
        return EmptyGraph()

    monkeypatch.setattr(runner_module, "build_graph", capture)

    session_id = "test-run-attachments"
    sessions.reset(session_id)
    await _drive(
        session_id,
        Phase.PLAN,
        "build it",
        str(sample_project),
        False,
        attachments=["notes.md"],
    )

    assert captured, "the run never reached the graph"
    assert captured[0].prompt.startswith("build it")
    assert "# Notes" in captured[0].prompt
    assert [message.content for message in sessions.get(session_id).messages] == ["build it"]
