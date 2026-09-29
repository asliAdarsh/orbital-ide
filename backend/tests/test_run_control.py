"""Run control: pause, resume, and the side question asked beside a run.

Every test drives the real graph and the real run driver with a scripted chat model, so what is
asserted is what the composer actually sees — where a run stops, what the session reports while it
is stopped, what a resume continues, and what a side question is allowed to touch — with no
provider and no network.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import time
from collections.abc import Callable, Iterator
from typing import Annotated, Any, AsyncIterator

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import InjectedToolCallId, tool

from orbital_backend import ws as ws_module
from orbital_backend.agents import graph as graph_module
from orbital_backend.agents import runner as runner_module
from orbital_backend.config import settings
from orbital_backend.events import bus
from orbital_backend.models import (
    AgentId,
    ChatMessage,
    MessageRole,
    Phase,
    PhaseStatus,
    ProviderKind,
    ProviderProfile,
    RunStatus,
    SessionState,
)
from orbital_backend.services.sessions import sessions
from orbital_backend.tools.context import ToolContext, run_tool

BRIEF = "Write plan.md describing the requirement and the stack."
SPECIALIST = "the plan is written"
VERDICT = "DECISION: ADVANCE\nREASON: the deliverable matches the brief\nSUMMARY: phase complete"


# -------------------------------------------------------------------------------------
# Scripted models and other doubles
# -------------------------------------------------------------------------------------


class Hold:
    """A rendezvous that keeps one model call open until the test lets it go.

    A scripted run finishes before a test could pause anything, so a pause test without this would
    be a race against the event loop. Holding a call makes "the pause arrived while this call was
    still being written" a fact: the boundary the pause is meant to stop is the *next* one.
    """

    def __init__(self, at: int) -> None:
        #: Which model call (0-indexed) to hold open.
        self.at = at
        self.opened = asyncio.Event()
        self.release = asyncio.Event()


class RunModel(BaseChatModel):
    """The scripted model a run talks to: streams canned replies, and can be held on one call."""

    replies: list[str] = []
    calls: int = 0
    hold: Any = None

    @property
    def _llm_type(self) -> str:
        return "orbital-run-scripted"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "RunModel":
        return self

    def _next_reply(self) -> str:
        """Take the reply for the next call. Counting at entry keeps ``calls`` a start count."""
        reply = self.replies[min(self.calls, len(self.replies) - 1)]
        self.calls += 1
        return reply

    def _generate(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        # The graph drives every call through ``_astream``; the base class still requires this.
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=self._next_reply()))])

    async def _astream(
        self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any
    ) -> AsyncIterator[ChatGenerationChunk]:
        index = self.calls
        reply = self._next_reply()
        if self.hold is not None and index == self.hold.at:
            self.hold.opened.set()
            await self.hold.release.wait()
        for token in reply.split(" "):
            yield ChatGenerationChunk(message=AIMessageChunk(content=f"{token} "))


class AnswerModel(BaseChatModel):
    """The scripted model a side question talks to.

    ``fail_after`` is how many tokens are emitted before the answer dies — a question that fails
    half-way is the case the client has to be told about on its own stream. ``hold_after`` is the
    same point for cancellation: a question held mid-answer is one there is something to cancel.
    ``seen`` keeps the messages each call was given, so a test can read what the question was
    actually asked with.
    """

    replies: list[str] = []
    calls: int = 0
    fail_after: int | None = None
    hold_after: int | None = None
    opened: Any = None
    release: Any = None
    seen: list[list[Any]] = []

    @property
    def _llm_type(self) -> str:
        return "orbital-answer-scripted"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "AnswerModel":
        return self

    def _reply(self) -> str:
        reply = self.replies[min(self.calls, len(self.replies) - 1)]
        self.calls += 1
        return reply

    def _generate(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=self._reply()))])

    async def _astream(
        self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any
    ) -> AsyncIterator[ChatGenerationChunk]:
        self.seen.append([*messages])
        reply = self._reply()
        for position, token in enumerate(reply.split(" ")):
            if self.fail_after is not None and position == self.fail_after:
                raise RuntimeError("the endpoint hung up mid-answer")
            if self.hold_after is not None and position == self.hold_after:
                self.opened.set()
                await self.release.wait()
            yield ChatGenerationChunk(message=AIMessageChunk(content=f"{token} "))


class ToolModel(RunModel):
    """The specialist's first turn asks for one tool; every other turn streams prose.

    Keyed off the call index rather than ``bind_tools``: the orchestrator and the specialist share
    one scripted instance, and the call the tool is asked for on is a fact about the script.
    """

    replies: list[str] = []
    prose_calls: int = 0
    tool_name: str = "note"
    tool_args: dict[str, Any] = {}

    def _next_prose(self) -> str:
        reply = self.replies[min(self.prose_calls, len(self.replies) - 1)]
        self.prose_calls += 1
        return reply

    async def _astream(
        self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any
    ) -> AsyncIterator[ChatGenerationChunk]:
        index = self.calls
        self.calls += 1
        if self.hold is not None and index == self.hold.at:
            self.hold.opened.set()
            await self.hold.release.wait()
        if index == 1:
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content="",
                    tool_calls=[
                        {"name": self.tool_name, "args": self.tool_args, "id": "call-1"}
                    ],
                )
            )
            return
        for token in self._next_prose().split(" "):
            yield ChatGenerationChunk(message=AIMessageChunk(content=f"{token} "))


def _note_tool(ctx: ToolContext, written: list[str]):
    """A real tool, so the run's tool frames are the ones the app emits."""

    @tool
    async def note(text: str, tool_call_id: Annotated[str, InjectedToolCallId] = "") -> str:
        """Write a one-line note into the workspace."""

        async def invoke() -> str:
            written.append(text)
            (ctx.root / "note.txt").write_text(text, encoding="utf-8")
            return f"OK: wrote {len(text)} bytes to note.txt"

        return await run_tool(ctx, "note", tool_call_id, {"text": text}, invoke)

    return note


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


class ScriptedSocket:
    """A socket that replays scripted inbound frames and records what came back."""

    def __init__(self, *frames: dict[str, object]) -> None:
        self._inbound = [json.dumps(frame) for frame in frames]
        self.sent: list[dict[str, Any]] = []
        # A missing Origin is a non-browser local client, and the token is what gates it.
        self.headers: dict[str, str] = {}

    async def accept(self) -> None:
        return None

    async def receive_text(self) -> str:
        if not self._inbound:
            from starlette.websockets import WebSocketDisconnect

            raise WebSocketDisconnect()
        return self._inbound.pop(0)

    async def send_json(self, frame: dict[str, Any]) -> None:
        self.sent.append(frame)


def _scripted_run(monkeypatch: pytest.MonkeyPatch, model: RunModel) -> FrameRecorder:
    """Point the whole run driver at one scripted model, and capture its frames."""
    recorder = FrameRecorder()
    monkeypatch.setattr(bus, "emit", recorder)
    monkeypatch.setattr(settings, "llm_api_key", "sk-test-not-real")
    monkeypatch.setattr(graph_module, "build_llm", lambda **_kwargs: model)
    monkeypatch.setattr(graph_module, "tools_for", lambda agent, ctx: [])
    return recorder


async def _until(predicate: Callable[[], bool], timeout: float = 5.0) -> None:
    """Wait for a state the run reaches on its own, rather than guessing at a sleep."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("the run never reached the expected state")


async def _settled(session_id: str, quiet: float = 0.2) -> SessionState:
    """The transcript once it has stopped changing.

    A pause stops the run, not the delivery of the reply that was already produced, so this waits
    for that tail to finish arriving before anything is asserted about the transcript.
    """
    previous: list[ChatMessage] | None = None
    for _ in range(50):
        snapshot = sessions.get(session_id)
        if previous is not None and snapshot.messages == previous:
            return snapshot
        previous = snapshot.messages
        await asyncio.sleep(quiet)
    raise AssertionError("the transcript never settled")


# -------------------------------------------------------------------------------------
# Pause and resume
# -------------------------------------------------------------------------------------


async def test_a_run_stops_at_a_step_boundary_and_reports_paused(
    monkeypatch: pytest.MonkeyPatch, sample_project
) -> None:
    """A pause stops the run before the next model or tool call — not mid-token.

    The specialist's call is held open, the pause is asked for, and the call is released: the reply
    in flight is delivered whole, and the run stops before the orchestrator's verdict call. The
    session says ``paused`` from the moment it has actually stopped, and the phase it was working
    is neither settled nor restarted.
    """
    hold = Hold(at=1)
    model = RunModel(replies=[BRIEF, SPECIALIST, VERDICT], hold=hold)
    recorder = _scripted_run(monkeypatch, model)
    session_id = "run-control-pause"
    sessions.reset(session_id)

    task = asyncio.create_task(
        runner_module.start_run(session_id, Phase.PLAN, "plan it", str(sample_project), False)
    )
    await asyncio.wait_for(hold.opened.wait(), 5)

    assert runner_module.pause_run(session_id) is True
    hold.release.set()
    await _until(lambda: sessions.get(session_id).status is RunStatus.PAUSED)

    # Two calls started — the brief and the specialist's reply being held — and the third, the
    # verdict, is the step the pause stopped.
    assert model.calls == 2
    assert [frame["payload"].status for frame in recorder.of("session.state")][-1] is RunStatus.PAUSED

    paused = await _settled(session_id)
    await asyncio.sleep(0.3)
    assert model.calls == 2, "a paused run must not start another model call"
    assert sessions.get(session_id).messages == paused.messages, "a paused run must not keep writing"
    assert sessions.get(session_id).status is RunStatus.PAUSED
    assert sessions.get(session_id).phases[Phase.PLAN] is PhaseStatus.RUNNING, (
        "a pause settles nothing: the phase is still the run's"
    )

    runner_module.resume_run(session_id)
    await asyncio.wait_for(task, 10)


async def test_a_pause_stops_a_tool_call_before_it_runs(
    monkeypatch: pytest.MonkeyPatch, sample_project
) -> None:
    """The other half of the boundary: a pause requested before a tool call means the tool does not run.

    A pause that only stopped model calls would still let a shell command or a file write through,
    which is exactly what a user pressing Pause does not expect. The specialist asks for the tool,
    the pause is already in place, and the tool's effect must be missing until the run is resumed.
    """
    written: list[str] = []
    hold = Hold(at=1)
    model = ToolModel(replies=[BRIEF, SPECIALIST, VERDICT], hold=hold, tool_args={"text": "hello"})
    recorder = FrameRecorder()
    monkeypatch.setattr(bus, "emit", recorder)
    monkeypatch.setattr(settings, "llm_api_key", "sk-test-not-real")
    monkeypatch.setattr(graph_module, "build_llm", lambda **_kwargs: model)
    monkeypatch.setattr(
        graph_module, "tools_for", lambda agent, ctx: [_note_tool(ctx, written)]
    )

    session_id = "run-control-tool-pause"
    sessions.reset(session_id)
    task = asyncio.create_task(
        runner_module.start_run(session_id, Phase.PLAN, "plan it", str(sample_project), False)
    )
    await asyncio.wait_for(hold.opened.wait(), 5)
    runner_module.pause_run(session_id)
    hold.release.set()
    await _until(lambda: sessions.get(session_id).status is RunStatus.PAUSED)

    assert written == [], "a paused run must not run the tool the model just asked for"
    assert not (sample_project / "note.txt").exists()
    assert recorder.of("agent.tool_call") == []
    assert model.calls == 2

    runner_module.resume_run(session_id)
    await asyncio.wait_for(task, 10)

    assert written == ["hello"], "resuming runs the step the pause stopped"
    assert (sample_project / "note.txt").read_text(encoding="utf-8") == "hello"
    assert len(recorder.of("agent.tool_call")) == 1
    assert sessions.get(session_id).status is RunStatus.DONE


async def test_resume_continues_the_same_run_without_repeating_a_step(
    monkeypatch: pytest.MonkeyPatch, sample_project
) -> None:
    """Resume continues the run that stopped; it does not start the phase again.

    Every reply the script has is used exactly once, the brief is announced once, and the
    transcript holds one copy of each turn — a restarted phase would show up as a second brief and
    a fourth model call.
    """
    hold = Hold(at=1)
    model = RunModel(replies=[BRIEF, SPECIALIST, VERDICT], hold=hold)
    recorder = _scripted_run(monkeypatch, model)
    session_id = "run-control-resume"
    sessions.reset(session_id)

    task = asyncio.create_task(
        runner_module.start_run(session_id, Phase.PLAN, "plan it", str(sample_project), False)
    )
    await asyncio.wait_for(hold.opened.wait(), 5)
    runner_module.pause_run(session_id)
    hold.release.set()
    await _until(lambda: sessions.get(session_id).status is RunStatus.PAUSED)

    assert len(recorder.of("phase.changed")) == 1, "the pause must not touch the phase"
    runner_module.resume_run(session_id)
    await asyncio.wait_for(task, 10)

    state = sessions.get(session_id)
    assert state.status is RunStatus.DONE
    assert model.calls == 3, "the run continued from where it stopped, it did not restart"

    # The orchestrator speaks twice per phase by design — the brief and the verdict — so a
    # restarted phase would show up here as a third turn and a fourth model call.
    starts = [frame["payload"]["agent"] for frame in recorder.of("agent.message.start")]
    assert starts.count(AgentId.ARCHITECT.value) == 1, "the specialist's turn is streamed once"
    assert starts.count(AgentId.ORCHESTRATOR.value) == 2, "one brief and one verdict, no more"

    transcript = "\n".join(message.content for message in state.messages)
    assert transcript.count(SPECIALIST) == 1, "a completed step must not be replayed"
    assert transcript.count(BRIEF) == 1
    # Back to running on the way out, so the client never reads a stale pause.
    assert [frame["payload"].status for frame in recorder.of("session.state")][-1] is RunStatus.DONE
    assert RunStatus.RUNNING in [frame["payload"].status for frame in recorder.of("session.state")]


async def test_pausing_an_idle_session_is_a_no_op(monkeypatch: pytest.MonkeyPatch) -> None:
    """Nothing running is not an error: the user pressed a button that is already satisfied."""
    session_id = "run-control-idle"
    sessions.reset(session_id)

    assert runner_module.pause_run(session_id) is False
    assert runner_module.resume_run(session_id) is False
    assert sessions.get(session_id).status is RunStatus.IDLE


async def test_a_pause_frame_on_an_idle_session_answers_with_a_notice(
    auth_token: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The notice travels as a log line, not as an ``error`` the composer would dress as a failure."""
    socket = ScriptedSocket(
        {"type": "auth", "token": auth_token},
        {"type": "subscribe", "sessionId": "run-control-idle-ws"},
        {"type": "agent.pause", "sessionId": "run-control-idle-ws"},
        {"type": "agent.resume", "sessionId": "run-control-idle-ws"},
    )
    monkeypatch.setattr(ws_module.bus, "emit", _passthrough(ws_module.bus.emit))

    await ws_module.websocket_endpoint(socket)

    # Subscribing also replays whatever artefacts the open workspace has on disk, which is not this
    # test's subject.
    types = [frame["type"] for frame in socket.sent if frame["type"] != "artifact.updated"]
    assert types == ["session.state", "log", "log"], socket.sent
    assert "nothing to pause" in socket.sent[1]["payload"]["message"]
    assert "nothing to resume" in socket.sent[2]["payload"]["message"]
    assert "error" not in types


def _passthrough(original: Callable[..., Any]) -> Callable[..., Any]:
    """Let the real bus broadcast as well as record, so the socket receives its frames."""

    async def emit(type_: str, payload: Any, *, session_id: str | None = None) -> None:
        await original(type_, payload, session_id=session_id)

    return emit


async def test_cancel_wins_over_a_pause(monkeypatch: pytest.MonkeyPatch, sample_project) -> None:
    """A paused run is still a run: cancelling it stops it for good rather than parking it."""
    hold = Hold(at=1)
    model = RunModel(replies=[BRIEF, SPECIALIST, VERDICT], hold=hold)
    recorder = _scripted_run(monkeypatch, model)
    session_id = "run-control-cancel"
    sessions.reset(session_id)

    task = asyncio.create_task(
        runner_module.start_run(session_id, Phase.PLAN, "plan it", str(sample_project), False)
    )
    await asyncio.wait_for(hold.opened.wait(), 5)
    runner_module.pause_run(session_id)
    hold.release.set()
    await _until(lambda: sessions.get(session_id).status is RunStatus.PAUSED)

    assert await runner_module.cancel_run(session_id) is True
    with pytest.raises(asyncio.CancelledError):
        await task

    assert sessions.get(session_id).status is RunStatus.CANCELLED
    done = recorder.of("agent.done")
    assert done and done[-1]["payload"]["status"] == RunStatus.CANCELLED.value

    stopped_at = model.calls
    await asyncio.sleep(0.3)
    assert model.calls == stopped_at, "a cancelled run must not resume itself"


# -------------------------------------------------------------------------------------
# Side questions
# --------------------------------------------------------------------------------------


async def test_a_side_question_is_answered_beside_a_run_without_touching_it(
    monkeypatch: pytest.MonkeyPatch, sample_project
) -> None:
    """The point of the feature: an answer arrives while the agent keeps working.

    The run's own model call is held open for the whole test, so the answer cannot have come from
    anything the run did. The question's frames are the only ones added, the transcript is the same
    list of messages it was before, and the run's status never leaves ``running``.
    """
    hold = Hold(at=1)
    run_model = RunModel(replies=[BRIEF, SPECIALIST, VERDICT], hold=hold)
    answer_model = AnswerModel(replies=["The plan names Vite and React."])
    recorder = _scripted_run(monkeypatch, run_model)
    monkeypatch.setattr(runner_module, "build_llm", lambda **_kwargs: answer_model)

    session_id = "run-control-ask-beside"
    sessions.reset(session_id)
    task = asyncio.create_task(
        runner_module.start_run(session_id, Phase.PLAN, "plan it", str(sample_project), False)
    )
    await asyncio.wait_for(hold.opened.wait(), 5)
    before = sessions.get(session_id)
    frames_before = len(recorder.frames)

    await runner_module.ask(session_id, "which stack did we pick?", "req-beside")

    assert not hold.release.is_set(), "the run's model call was still open the whole time"
    answers = [frame for frame in recorder.frames[frames_before:] if frame["type"].startswith("agent.answer")]
    assert [frame["type"] for frame in answers] == [
        "agent.answer.start",
        "agent.answer.token",
        "agent.answer.token",
        "agent.answer.token",
        "agent.answer.token",
        "agent.answer.token",
        "agent.answer.token",
        "agent.answer.end",
    ], answers
    assert {frame["payload"]["requestId"] for frame in answers} == {"req-beside"}
    assert answers[-1]["payload"]["content"].strip() == "The plan names Vite and React."
    assert answers[-1]["payload"]["error"] is None
    # The answer is not chat: no message frames, no transcript entry.
    assert not [
        frame for frame in recorder.frames[frames_before:] if frame["type"].startswith("agent.message")
    ]

    after = sessions.get(session_id)
    assert after.status is RunStatus.RUNNING, "a side question must not change the run's status"
    assert after.error is None
    assert [message.id for message in after.messages] == [message.id for message in before.messages]
    assert "Vite" not in "\n".join(message.content for message in after.messages)
    assert run_model.calls == 2, "a side question is not a step of the run"

    hold.release.set()
    await asyncio.wait_for(task, 10)
    assert sessions.get(session_id).status is RunStatus.DONE


async def test_a_side_question_uses_the_provider_the_run_is_pinned_to(
    monkeypatch: pytest.MonkeyPatch, sample_project
) -> None:
    """A pinned run and a question beside it must talk to the same endpoint."""
    pinned = ProviderProfile(
        id="profile-pinned",
        label="Pinned",
        kind=ProviderKind.LOCAL,
        base_url="http://127.0.0.1:9/v1",
        model="pinned-model",
        created_at=0,
    )
    hold = Hold(at=1)
    run_model = RunModel(replies=[BRIEF, SPECIALIST, VERDICT], hold=hold)
    _scripted_run(monkeypatch, run_model)
    handed: list[dict[str, Any]] = []

    def build(**kwargs: Any) -> AnswerModel:
        handed.append(kwargs)
        return AnswerModel(replies=["Pinned answers this one."])

    monkeypatch.setattr(runner_module, "build_llm", build)

    session_id = "run-control-ask-pinned"
    sessions.reset(session_id)
    task = asyncio.create_task(
        runner_module.start_run(
            session_id,
            Phase.PLAN,
            "plan it",
            str(sample_project),
            False,
            "pinned-model",
            provider=pinned,
        )
    )
    await asyncio.wait_for(hold.opened.wait(), 5)
    await runner_module.ask(session_id, "who answers this?", "req-pinned")

    assert handed and handed[-1]["profile"] is pinned
    assert handed[-1]["model"] == "pinned-model"

    hold.release.set()
    await asyncio.wait_for(task, 10)


async def test_a_side_question_with_no_run_asks_the_active_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With nothing pinned and nothing running, the question goes to the active profile."""
    handed: list[dict[str, Any]] = []

    def build(**kwargs: Any) -> AnswerModel:
        handed.append(kwargs)
        return AnswerModel(replies=["Answered by the active profile."])

    monkeypatch.setattr(bus, "emit", FrameRecorder())
    monkeypatch.setattr(runner_module, "build_llm", build)
    session_id = "run-control-ask-idle"
    sessions.reset(session_id)

    await runner_module.ask(session_id, "anything?", "req-idle")

    assert handed and handed[-1]["profile"] is None
    assert handed[-1]["model"] is None


async def test_a_side_question_is_asked_with_the_chats_recent_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The answer is grounded in the conversation, and asking writes nothing back into it."""
    answer_model = AnswerModel(replies=["You chose Vite."])
    monkeypatch.setattr(bus, "emit", FrameRecorder())
    monkeypatch.setattr(runner_module, "build_llm", lambda **_kwargs: answer_model)

    session_id = "run-control-ask-context"
    sessions.reset(session_id)
    sessions.add_message(
        session_id,
        ChatMessage(
            id="m1",
            role=MessageRole.USER,
            agent=AgentId.ORCHESTRATOR,
            content="we chose Vite for the bundler",
            phase=Phase.PLAN,
            created_at=0,
            streaming=False,
        ),
    )
    before = [message.id for message in sessions.get(session_id).messages]

    await runner_module.ask(session_id, "which bundler did we pick?", "req-context")

    asked = answer_model.seen[0]
    assert asked[0].content.startswith("You are answering one question")
    assert "we chose Vite for the bundler" in "\n".join(message.content for message in asked)
    assert asked[-1].content == "which bundler did we pick?"
    assert [message.id for message in sessions.get(session_id).messages] == before


async def test_two_side_questions_do_not_interleave_their_tokens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two answers at once arrive as two uninterrupted streams, never as one mixed stream."""
    first, second = "alpha one alpha two", "beta one beta two"
    answer_model = AnswerModel(replies=[first, second])
    recorder = FrameRecorder()
    monkeypatch.setattr(bus, "emit", recorder)
    monkeypatch.setattr(runner_module, "build_llm", lambda **_kwargs: answer_model)
    session_id = "run-control-ask-pair"
    sessions.reset(session_id)

    await asyncio.gather(
        runner_module.ask(session_id, "first?", "req-a"),
        runner_module.ask(session_id, "second?", "req-b"),
    )

    tokens = recorder.of("agent.answer.token")
    order = [frame["payload"]["requestId"] for frame in tokens]
    runs: list[tuple[str, Iterator[dict[str, Any]]]] = [
        (request_id, group) for request_id, group in itertools.groupby(tokens, key=lambda f: f["payload"]["requestId"])
    ]
    assert len(runs) == 2, f"the two answers interleaved: {order}"
    assert {request_id for request_id, _ in runs} == {"req-a", "req-b"}

    assembled = {
        request_id: "".join(frame["payload"]["text"] for frame in group)
        for request_id, group in itertools.groupby(tokens, key=lambda f: f["payload"]["requestId"])
    }
    assert {text.strip() for text in assembled.values()} == {first, second}
    assert len(recorder.of("agent.answer.start")) == 2
    assert [frame["payload"]["content"] for frame in recorder.of("agent.answer.end")] == [
        assembled["req-a"],
        assembled["req-b"],
    ]


async def test_a_failed_question_is_reported_on_its_own_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A question that dies reports that on the question's stream, never as the run's error."""
    answer_model = AnswerModel(replies=["half an answer that stops"], fail_after=3)
    recorder = FrameRecorder()
    monkeypatch.setattr(bus, "emit", recorder)
    monkeypatch.setattr(runner_module, "build_llm", lambda **_kwargs: answer_model)
    session_id = "run-control-ask-failure"
    sessions.reset(session_id)

    await runner_module.ask(session_id, "why?", "req-fail")

    starts = recorder.of("agent.answer.start")
    ends = recorder.of("agent.answer.end")
    assert len(starts) == 1 and len(ends) == 1, recorder.types()
    assert ends[0]["payload"]["requestId"] == "req-fail"
    assert ends[0]["payload"]["content"].strip() == "half an answer"
    assert "hung up mid-answer" in (ends[0]["payload"]["error"] or "")
    assert recorder.of("agent.error") == [], "the run's error stream belongs to the run"
    state = sessions.get(session_id)
    assert state.status is RunStatus.IDLE and state.error is None


async def test_a_side_question_can_be_cancelled_on_its_own(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cancelling a question stops the answer and leaves everything else alone."""
    answer_model = AnswerModel(
        replies=["one two three four"],
        hold_after=1,
        opened=asyncio.Event(),
        release=asyncio.Event(),
    )
    recorder = FrameRecorder()
    monkeypatch.setattr(bus, "emit", recorder)
    monkeypatch.setattr(runner_module, "build_llm", lambda **_kwargs: answer_model)
    session_id = "run-control-ask-cancel"
    sessions.reset(session_id)

    task = asyncio.create_task(runner_module.ask(session_id, "slow?", "req-cancel"))
    await asyncio.wait_for(answer_model.opened.wait(), 5)
    assert runner_module.cancel_ask("req-cancel") is True
    with pytest.raises(asyncio.CancelledError):
        await task

    ends = recorder.of("agent.answer.end")
    assert ends and ends[-1]["payload"]["error"] == "The question was cancelled."
    assert ends[-1]["payload"]["content"].strip() == "one"
    assert runner_module.cancel_ask("req-cancel") is False, "an answer that is gone cannot be cancelled again"
    assert recorder.of("agent.error") == []
    assert sessions.get(session_id).status is RunStatus.IDLE
