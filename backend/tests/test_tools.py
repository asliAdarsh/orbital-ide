"""Tests for the agent tool layer (section 8 of the frozen interfaces)."""

from __future__ import annotations

import base64
import json
import os
import shlex
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from orbital_backend.errors import OrbitalError, WorkspaceError
from orbital_backend.models import CAPABILITIES, AgentId
from orbital_backend.services.attachments import (
    MAX_TEXT_FILE_BYTES,
    build_chat_context,
    build_run_context,
)
from orbital_backend.services.workspace import workspace
from orbital_backend.tools import CAPABILITY_TOOLS, tools_for
from orbital_backend.tools import web as web_module
from orbital_backend.tools.context import ToolContext
from orbital_backend.tools.web import MAX_TEXT_CHARS

pytestmark = pytest.mark.asyncio


class FakeBus:
    """Records what a real event bus would have broadcast to the UI."""

    def __init__(self) -> None:
        self.frames: list[tuple[str, Any]] = []
        self.terminal: list[tuple[str, str]] = []

    async def emit(self, type_: str, payload: Any, *, session_id: str | None = None) -> None:
        self.frames.append((type_, payload))

    async def emit_terminal(
        self, session_id: str, command_id: str, channel: str, data: str
    ) -> None:
        self.terminal.append((channel, data))


def python_command(code: str) -> str:
    """Quote an interpreter one-liner for whichever shell the runner spawns."""
    if os.name == "nt":
        return f'"{sys.executable}" -c "{code}"'
    return f"{shlex.quote(sys.executable)} -c {shlex.quote(code)}"


def tool_named(ctx: ToolContext, name: str) -> Any:
    for candidate in tools_for(AgentId.CODE_ENGINE, ctx):
        if candidate.name == name:
            return candidate
    raise AssertionError(f"tool {name!r} was not built")


async def invoke(tool: Any, call_id: str = "call-1", **args: Any) -> str:
    message = await tool.ainvoke(
        {"name": tool.name, "args": args, "type": "tool_call", "id": call_id}
    )
    return str(message.content)


@pytest.fixture()
def bus() -> FakeBus:
    return FakeBus()


@pytest.fixture()
def ctx(tmp_path: Path, bus: FakeBus) -> ToolContext:
    workspace.set_root(tmp_path)
    return ToolContext(
        session_id="test-session",
        agent=AgentId.CODE_ENGINE,
        root=tmp_path,
        emit=bus.emit,
        bus=bus,
    )


async def test_write_file_creates_nested_dirs_and_read_file_round_trips(ctx: ToolContext) -> None:
    payload = "orbital round trip"
    written = await invoke(
        tool_named(ctx, "write_file"), path="nested/deep/hello.txt", content=payload
    )
    assert written.startswith("OK:")
    assert f"({len(payload.encode('utf-8'))} bytes)" in written
    target = ctx.root / "nested" / "deep" / "hello.txt"
    assert target.read_text(encoding="utf-8") == payload

    read_back = await invoke(tool_named(ctx, "read_file"), path="nested/deep/hello.txt")
    assert read_back.startswith("OK:")
    assert read_back.split("\n", 1)[1] == payload


async def test_read_file_outside_the_root_is_error(ctx: ToolContext) -> None:
    result = await invoke(tool_named(ctx, "read_file"), path="../escaped.txt")
    assert result.startswith("ERROR:")


async def test_list_directory_omits_ignored_directories(ctx: ToolContext) -> None:
    (ctx.root / "node_modules" / "left-pad").mkdir(parents=True)
    (ctx.root / "node_modules" / "left-pad" / "index.js").write_text(
        "module.exports = 1", encoding="utf-8"
    )
    (ctx.root / "src").mkdir()
    (ctx.root / "src" / "main.py").write_text("print('hi')", encoding="utf-8")

    result = await invoke(tool_named(ctx, "list_directory"), path=".")
    assert result.startswith("OK:")
    assert "node_modules" not in result
    assert "src/" in result
    assert "main.py" in result


async def test_search_files_reports_the_line_number_and_skips_ignored_dirs(
    ctx: ToolContext,
) -> None:
    (ctx.root / "target.py").write_text(
        "first line\norbital_marker_42 = True\nthird line\n", encoding="utf-8"
    )
    (ctx.root / "node_modules").mkdir()
    (ctx.root / "node_modules" / "noise.py").write_text(
        "orbital_marker_42 = False\n", encoding="utf-8"
    )

    result = await invoke(tool_named(ctx, "search_files"), pattern=r"orbital_marker_\d+")
    assert result.startswith("OK:")
    assert "1 hit(s)" in result
    assert "target.py:2:" in result
    assert "noise.py" not in result


async def test_run_command_streams_chunks_and_reports_the_exit_code(
    ctx: ToolContext, bus: FakeBus
) -> None:
    command = python_command("print('orbital_stream_line')")
    result = await invoke(tool_named(ctx, "run_command"), command=command, timeout=120)

    assert result.startswith("OK:"), result
    assert "exit=0" in result
    assert "orbital_stream_line" in result
    assert bus.terminal, "the runner streamed no chunks"
    assert "orbital_stream_line" in "".join(data for _, data in bus.terminal)

    emitted = [type_ for type_, _ in bus.frames]
    assert emitted[0] == "agent.tool_call"
    assert emitted[-1] == "agent.tool_result"
    call_frame, result_frame = bus.frames[0][1], bus.frames[-1][1]
    assert call_frame.id == result_frame.id == "call-1"
    assert call_frame.args["command"] == command
    assert result_frame.ok is True


async def test_git_status_outside_a_repository_is_structured(ctx: ToolContext) -> None:
    result = await invoke(tool_named(ctx, "git_status"))
    assert result.startswith(("OK:", "ERROR:"))
    payload = json.loads(result.split("\n", 1)[1])
    assert payload["available"] is True
    assert payload["repo"] is False
    assert payload["changed"] == []


async def test_git_branch_creates_and_switches(ctx: ToolContext) -> None:
    """The branching model is only real if a branch can actually be created and entered."""
    import subprocess

    root = ctx.root
    subprocess.run(["git", "init"], cwd=root, check=True, capture_output=True)
    subprocess.run(
        ["git", "-c", "user.email=t@example.com", "-c", "user.name=T", "commit",
         "--allow-empty", "-m", "init"],
        cwd=root,
        check=True,
        capture_output=True,
    )

    created = await invoke(tool_named(ctx, "git_branch"), name="feat/checkout-total", create=True)
    assert created.startswith("OK:")
    head = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=root, capture_output=True, text=True
    )
    assert head.stdout.strip() == "feat/checkout-total"

    # Back to whatever the default branch is called here — `main` or `master`, depending on the
    # git build, which is exactly why the test asks rather than assumes.
    default = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=root, capture_output=True, text=True
    ).stdout.strip()
    switched = await invoke(tool_named(ctx, "git_branch"), name=default)
    assert switched.startswith("OK:")
    head = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=root, capture_output=True, text=True
    )
    assert head.stdout.strip() == default


async def test_git_branch_refuses_a_name_that_is_not_a_name(ctx: ToolContext) -> None:
    """A typo must not become a ref: refusal happens before git is asked."""
    import subprocess

    subprocess.run(["git", "init"], cwd=ctx.root, check=True, capture_output=True)

    for bad in ("../escape", "with space", "-f", "trailing/"):
        result = await invoke(tool_named(ctx, "git_branch"), name=bad, create=True)
        assert result.startswith("ERROR:"), bad


async def test_git_branch_outside_a_repository_says_so(ctx: ToolContext) -> None:
    result = await invoke(tool_named(ctx, "git_branch"), name="feat/x", create=True)
    assert result.startswith("ERROR:")
    assert "not a git repository" in result


def test_every_agent_can_do_what_its_prompt_tells_it_to(ctx: ToolContext) -> None:
    """The tool sets have to cover the prompts.

    Both failures this guards against were real: the architect was told to write the design mocks
    and had no `write_file` (so a design phase could only report the blocker), and the QA was told
    to write patches and could not.
    """
    from orbital_backend.models import AgentId
    from orbital_backend.tools import tools_for

    def names(agent: AgentId) -> set[str]:
        return {tool.name for tool in tools_for(agent, ctx)}

    architect = names(AgentId.ARCHITECT)
    assert {"write_artifact", "write_file", "read_file", "list_directory"} <= architect
    assert "run_command" not in architect, "the architect does not run commands"

    qa = names(AgentId.QA)
    assert {"write_file", "write_artifact", "run_tests", "read_file"} <= qa

    code_engine = names(AgentId.CODE_ENGINE)
    assert {"write_file", "run_command", "git_init", "git_branch", "git_push"} <= code_engine

    orchestrator = names(AgentId.ORCHESTRATOR)
    assert not {"write_file", "write_artifact", "run_command"} & orchestrator

    # The working list is not a workspace tool, so every agent has it — the tool rules tell each
    # of them to keep it current, and a prompt naming a tool the agent does not have is a lie.
    for agent in AgentId:
        assert "update_todos" in names(agent), agent


# -------------------------------------------------------------------------------------
# The working list
# -------------------------------------------------------------------------------------


async def test_update_todos_publishes_the_whole_list(ctx: ToolContext, bus: FakeBus) -> None:
    """The list replaces the previous one, so the UI never has to merge two of them."""
    tool = tool_named(ctx, "update_todos")

    result = await invoke(
        tool,
        items=[
            {"content": "read the plan", "status": "completed"},
            {"content": "write the code", "status": "in_progress"},
        ],
    )
    assert result.startswith("OK:")

    await invoke(tool, call_id="call-2", items=[{"content": "ship it", "status": "pending"}])

    published = [payload for type_, payload in bus.frames if type_ == "agent.todos"]
    assert len(published) == 2, "one frame per call, and nothing else"
    assert [(item.content, item.status) for item in published[0].items] == [
        ("read the plan", "completed"),
        ("write the code", "in_progress"),
    ]
    assert [item.content for item in published[1].items] == ["ship it"]


@pytest.mark.parametrize(
    ("items", "expected"),
    [
        ([{"content": "   ", "status": "pending"}], "no content"),
        ([{"content": f"step {n}", "status": "pending"} for n in range(21)], "20"),
        ([{"content": "step", "status": "done"}], "pending, in_progress, completed"),
    ],
)
async def test_update_todos_refuses_a_list_it_cannot_publish(
    ctx: ToolContext, bus: FakeBus, items: list[dict[str, str]], expected: str
) -> None:
    result = await invoke(tool_named(ctx, "update_todos"), items=items)

    assert result.startswith("ERROR:"), result
    assert expected in result
    assert "agent.todos" not in [type_ for type_, _ in bus.frames], (
        "a refused list must never reach the user's list"
    )


# -------------------------------------------------------------------------------------
# Attachments
# -------------------------------------------------------------------------------------


async def test_attachments_inline_a_text_file_and_list_a_directory(ctx: ToolContext) -> None:
    (ctx.root / "src").mkdir()
    (ctx.root / "src" / "main.py").write_text("print('hi')\n", encoding="utf-8")
    (ctx.root / "notes.md").write_text("# Notes\n", encoding="utf-8")

    context = build_chat_context(["src", "notes.md"])

    assert "### `src` — directory, 1 entry" in context.text
    assert "`main.py` (file)" in context.text
    assert "```md" in context.text
    assert "# Notes" in context.text
    assert context.images == ()


async def test_an_attached_image_becomes_an_image_part(ctx: ToolContext) -> None:
    """A chat turn can carry the picture itself, which is the only way a vision model sees it."""
    payload = b"\x89PNG\r\n\x1a\n" + b"0" * 32
    (ctx.root / "logo.png").write_bytes(payload)

    context = build_chat_context(["logo.png"])

    assert "logo.png" in context.text
    assert len(context.images) == 1
    part = context.images[0]
    assert part["type"] == "image_url"
    url = part["image_url"]["url"]
    assert url.startswith("data:image/png;base64,")
    assert base64.b64decode(url.split(",", 1)[1]) == payload


async def test_a_run_names_an_image_without_embedding_it(ctx: ToolContext) -> None:
    """The supervisor's brief is a string, so a run cannot carry the picture — say so rather
    than implying the model was given something it cannot see."""
    (ctx.root / "logo.png").write_bytes(b"\x89PNG" + b"0" * 32)

    block = build_run_context(["logo.png"])

    assert "logo.png" in block
    assert "cannot see it" in block
    assert "base64" not in block


async def test_an_attachment_outside_the_workspace_is_refused(ctx: ToolContext) -> None:
    with pytest.raises(WorkspaceError) as caught:
        build_chat_context(["../escaped.txt"])

    assert "../escaped.txt" in caught.value.detail


async def test_an_oversized_text_file_is_capped_with_a_note(ctx: ToolContext) -> None:
    """A 200 KB file must not be inlined whole, and the model has to be told what it is missing."""
    target = ctx.root / "big.py"
    target.write_text("x = 1\n" * 40_000, encoding="utf-8")
    size = target.stat().st_size
    assert size > MAX_TEXT_FILE_BYTES

    block = build_chat_context(["big.py"]).text

    assert f"showing the first {MAX_TEXT_FILE_BYTES} of {size} bytes" in block
    assert len(block) < MAX_TEXT_FILE_BYTES + 500


# -------------------------------------------------------------------------------------
# Capabilities
# -------------------------------------------------------------------------------------


async def test_every_published_capability_is_enforced() -> None:
    """A capability the config dialog offers but the backend does not enforce would be a lie, and
    one the backend enforces but never publishes would be invisible."""
    assert {info.id for info in CAPABILITIES} == set(CAPABILITY_TOOLS)


@pytest.mark.parametrize(
    ("capability", "withheld"),
    [
        ("web", {"fetch_url"}),
        ("commands", {"run_command"}),
        ("todos", {"update_todos"}),
        ("write", {"write_file", "write_artifact", "delete_file"}),
        ("tests", {"run_tests"}),
        ("git", {"git_status", "git_init", "git_branch", "git_commit", "git_push"}),
    ],
)
async def test_turning_a_capability_off_removes_exactly_its_tools(
    ctx: ToolContext, capability: str, withheld: set[str]
) -> None:
    """What the contract names for a capability is what its absence takes away — no more, so the
    user is not surprised, and no less, so the switch means something."""
    everything = {tool.name for tool in tools_for(AgentId.CODE_ENGINE, ctx)}
    others = [info.id for info in CAPABILITIES if info.id != capability]

    remaining = {tool.name for tool in tools_for(AgentId.CODE_ENGINE, ctx, capabilities=others)}

    assert withheld <= everything, f"{capability} names a tool no agent can have"
    assert everything - remaining == withheld


async def test_a_capability_can_only_remove_tools(ctx: ToolContext) -> None:
    """Enabling everything must leave the orchestrator exactly read-only: `write` is a capability,
    not a way to hand an agent a tool its own set withholds."""
    every = [info.id for info in CAPABILITIES]

    names = {tool.name for tool in tools_for(AgentId.ORCHESTRATOR, ctx, capabilities=every)}

    assert names == {tool.name for tool in tools_for(AgentId.ORCHESTRATOR, ctx)}
    assert not names & {"write_file", "write_artifact", "delete_file", "run_command", "fetch_url"}


async def test_tools_for_refuses_a_capability_it_does_not_know(ctx: ToolContext) -> None:
    """Ignoring it would run the agent with every tool the caller meant to withhold."""
    with pytest.raises(OrbitalError) as caught:
        tools_for(AgentId.CODE_ENGINE, ctx, capabilities=["teleport"])

    assert "teleport" in caught.value.detail


# -------------------------------------------------------------------------------------
# The web tool
# -------------------------------------------------------------------------------------


def _serve(
    monkeypatch: pytest.MonkeyPatch, handler: Callable[[httpx.Request], httpx.Response]
) -> None:
    """Point the web tool at a scripted transport, so no test here touches the network."""
    monkeypatch.setattr(
        web_module, "_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )


async def test_fetch_url_refuses_a_scheme_that_is_not_http(
    ctx: ToolContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A local path is not a documentation page and must not be read as one."""

    def forbidden(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("a refused scheme must not reach the network")

    _serve(monkeypatch, forbidden)

    result = await invoke(tool_named(ctx, "fetch_url"), url="file:///etc/passwd")

    assert result.startswith("ERROR:")
    assert "file" in result


async def test_fetch_url_refuses_a_response_that_is_not_text(
    ctx: ToolContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    _serve(
        monkeypatch,
        lambda _request: httpx.Response(
            200, headers={"content-type": "application/pdf"}, content=b"%PDF-1.4"
        ),
    )

    result = await invoke(tool_named(ctx, "fetch_url"), url="https://docs.test/manual.pdf")

    assert result.startswith("ERROR:")
    assert "application/pdf" in result


async def test_fetch_url_returns_a_page_as_readable_text(
    ctx: ToolContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Tags, scripts and whitespace runs are exactly what the model would otherwise pay to read."""
    asked: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        asked.append(str(request.url))
        return httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text=(
                "<html><head><title>Orbital</title>"
                "<style>body { color: red }</style>"
                "<script>window.tracker = 'noise'</script></head>"
                "<body><h1>Install</h1>\n\n  <p>Run <code>npm install</code> first.</p>"
                "</body></html>"
            ),
        )

    _serve(monkeypatch, handler)

    result = await invoke(tool_named(ctx, "fetch_url"), url="https://docs.test/start")

    assert asked == ["https://docs.test/start"]
    assert result.startswith("OK:")
    assert "Install" in result
    assert "npm install" in result
    assert "noise" not in result, "a script body is not documentation"
    assert "<" not in result, "no markup survives"


async def test_fetch_url_caps_what_it_hands_the_model(
    ctx: ToolContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The output is replayed on every later turn of the run, so its length is a per-turn cost."""
    body = " ".join(f"word{index}" for index in range(MAX_TEXT_CHARS))
    _serve(
        monkeypatch,
        lambda _request: httpx.Response(
            200, headers={"content-type": "text/plain"}, text=body
        ),
    )

    result = await invoke(tool_named(ctx, "fetch_url"), url="https://docs.test/huge")

    assert result.startswith("OK:")
    assert "characters total]" in result
    assert len(result) < MAX_TEXT_CHARS + 200
