"""The command-approval gate and the `agent/` artefact layout.

The gate is the one place where a mistake means a shell command runs on the user's machine without
them seeing it, so its behaviour is pinned precisely — including the direction it fails in.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from orbital_backend.models import AgentId, CommandRequest, Phase
from orbital_backend.services import approvals as approvals_module
from orbital_backend.services.approvals import ApprovalRegistry
from orbital_backend.services.sessions import wire_state
from orbital_backend.services.workspace import workspace
from orbital_backend.tools import ToolContext, tools_for


class Recorder:
    """Stands in for the event bus, keeping every frame it was asked to broadcast."""

    def __init__(self) -> None:
        self.frames: list[tuple[str, Any]] = []

    async def emit(self, type_: str, payload: Any, *, session_id: str | None = None) -> None:
        self.frames.append((type_, payload))

    async def emit_terminal(self, *args: Any, **kwargs: Any) -> None:
        pass


def command_request(request_id: str = "call-1") -> CommandRequest:
    return CommandRequest(
        id=request_id,
        agent=AgentId.CODE_ENGINE,
        phase=Phase.BUILD,
        command="npm install",
        cwd="/work",
        tool="run_command",
    )


@pytest.fixture()
def recorder(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    instance = Recorder()
    monkeypatch.setattr(approvals_module.bus, "emit", instance.emit)
    return instance


async def test_a_command_is_held_until_the_user_decides(recorder: Recorder) -> None:
    registry = ApprovalRegistry()

    pending = asyncio.create_task(registry.request("s1", command_request()))
    await asyncio.sleep(0.02)

    assert not pending.done(), "the command must not proceed before anyone has answered"
    assert [name for name, _ in recorder.frames] == ["agent.command_request"]
    assert recorder.frames[0][1].command == "npm install"

    assert registry.resolve("s1", "call-1", approved=True, remember=False) is True
    assert await pending is True


async def test_a_refusal_is_reported_as_refused(recorder: Recorder) -> None:
    registry = ApprovalRegistry()

    pending = asyncio.create_task(registry.request("s1", command_request()))
    await asyncio.sleep(0.02)
    registry.resolve("s1", "call-1", approved=False, remember=False)

    assert await pending is False


async def test_silence_is_not_consent(
    recorder: Recorder, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unanswered request must never become an approval."""
    monkeypatch.setattr(approvals_module, "APPROVAL_TIMEOUT_SECONDS", 0.05)
    registry = ApprovalRegistry()

    assert await registry.request("s1", command_request()) is False


async def test_allow_all_lasts_exactly_as_long_as_the_run(recorder: Recorder) -> None:
    registry = ApprovalRegistry()

    first = asyncio.create_task(registry.request("s1", command_request("a")))
    await asyncio.sleep(0.02)
    registry.resolve("s1", "a", approved=True, remember=True)
    assert await first is True

    # The next command does not ask at all.
    assert await registry.request("s1", command_request("b")) is True
    assert [name for name, _ in recorder.frames] == ["agent.command_request"]

    # …until the run ends, at which point it asks again.
    registry.forget("s1")
    pending = asyncio.create_task(registry.request("s1", command_request("c")))
    await asyncio.sleep(0.02)
    assert not pending.done(), "a later run must ask again"
    registry.resolve("s1", "c", approved=False, remember=False)
    assert await pending is False


async def test_a_refusal_cannot_grant_blanket_permission(recorder: Recorder) -> None:
    registry = ApprovalRegistry()

    assert registry.resolve("s1", "nothing-pending", approved=False, remember=True) is False
    assert registry.is_remembered("s1") is False


async def test_allow_all_skips_the_gate_and_survives_the_run(recorder: Recorder) -> None:
    """The composer's mode is a standing choice, not the card's run-scoped grant: ending the run
    must not quietly put the cards back."""
    registry = ApprovalRegistry()
    registry.set_permission("s1", "allow_all")

    assert await registry.request("s1", command_request("a")) is True
    assert recorder.frames == [], "an allowed session must not be asked"

    registry.forget("s1")

    assert await registry.request("s1", command_request("b")) is True
    assert recorder.frames == [], "the user's choice outlives the run that was running"


async def test_switching_back_to_ask_restores_the_cards(recorder: Recorder) -> None:
    registry = ApprovalRegistry()
    registry.set_permission("s1", "allow_all")
    registry.set_permission("s1", "ask")

    pending = asyncio.create_task(registry.request("s1", command_request()))
    await asyncio.sleep(0.02)

    assert not pending.done(), "the card has to come back the moment the user asks for it"
    assert [name for name, _ in recorder.frames] == ["agent.command_request"]
    registry.resolve("s1", "call-1", approved=True, remember=False)
    assert await pending is True


async def test_the_standing_mode_is_not_the_runs_remembered_grant(recorder: Recorder) -> None:
    """Two permissions live side by side and only one of them ends with the run."""
    registry = ApprovalRegistry()
    registry.set_permission("standing", "allow_all")

    pending = asyncio.create_task(registry.request("grant", command_request()))
    await asyncio.sleep(0.02)
    registry.resolve("grant", "call-1", approved=True, remember=True)
    assert await pending is True

    registry.forget("grant")
    registry.forget("standing")

    assert registry.is_remembered("grant") is False, "the card's grant is run-scoped"
    assert registry.permission("standing") == "allow_all", "the user's mode is not"
    assert await registry.request("standing", command_request("b")) is True


async def test_a_held_command_rides_with_the_session_state(recorder: Recorder) -> None:
    """A socket that reconnects is told which command is still waiting on it.

    The request frame is emitted once, and the state frame is what a reconnecting client asks for,
    so the held command has to travel with it or the tool stalls until the request times out.
    """
    session_id = "s-wire"
    registry = approvals_module.approvals
    pending = asyncio.create_task(registry.request(session_id, command_request()))
    await asyncio.sleep(0.02)
    try:
        assert [c.command for c in wire_state(session_id).pending_commands] == ["npm install"]

        registry.resolve(session_id, "call-1", approved=True, remember=False)
        assert await pending is True
        assert wire_state(session_id).pending_commands == []
    finally:
        registry.forget(session_id)


async def test_artifacts_land_under_the_agent_folder(tmp_path: Path) -> None:
    """Everything the pipeline writes about a project lives beside it, not in its root."""
    workspace.set_root(tmp_path)
    recorder = Recorder()
    ctx = ToolContext(
        session_id="s",
        agent=AgentId.ARCHITECT,
        root=tmp_path,
        emit=recorder.emit,
        bus=recorder,
    )
    tool = next(tool for tool in tools_for(AgentId.ARCHITECT, ctx) if tool.name == "write_artifact")

    result = await tool.ainvoke(
        {
            "name": "write_artifact",
            "args": {"name": "plan.md", "content": "# plan"},
            "type": "tool_call",
            "id": "call-1",
        }
    )

    assert str(result.content).startswith("OK:")
    assert (tmp_path / "agent" / "plan.md").read_text(encoding="utf-8") == "# plan"
    assert not (tmp_path / "plan.md").exists(), "the project root must stay clean"
    emitted = [payload["name"] for name, payload in recorder.frames if name == "artifact.updated"]
    assert emitted == ["agent/plan.md"], "the UI keys artefacts by their relative path"


async def test_write_artifact_refuses_anything_else(tmp_path: Path) -> None:
    workspace.set_root(tmp_path)
    recorder = Recorder()
    ctx = ToolContext(
        session_id="s",
        agent=AgentId.ARCHITECT,
        root=tmp_path,
        emit=recorder.emit,
        bus=recorder,
    )
    tool = next(tool for tool in tools_for(AgentId.ARCHITECT, ctx) if tool.name == "write_artifact")

    result = await tool.ainvoke(
        {
            "name": "write_artifact",
            "args": {"name": "../../escape.md", "content": "nope"},
            "type": "tool_call",
            "id": "call-2",
        }
    )

    assert str(result.content).startswith("ERROR:")
    assert not (tmp_path.parent / "escape.md").exists()
