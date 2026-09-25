"""Shared plumbing for the Orbital agent tool layer.

Every tool routes its work through :func:`run_tool`, so each invocation produces one
``agent.tool_call`` frame followed by exactly one ``agent.tool_result`` frame. The
LangChain tool-call id is injected into the tool body and reused as the frame id, which
keeps the frontend inspector rows paired without any extra bookkeeping.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from ..errors import OrbitalError
from ..events import EventBus
from ..models import AgentId, Phase, ToolCall, ToolResult

TOOL_OUTPUT_LIMIT = 4096


@dataclass(slots=True)
class ToolContext:
    """What one agent invocation needs to reach the workspace and the event bus."""

    session_id: str
    agent: AgentId
    root: Path
    emit: Callable[..., Awaitable[None]]
    bus: EventBus
    #: The phase the agent is working on, for the approval card's context line.
    phase: Phase = Phase.BUILD
    #: Ask the user to allow a shell command: ``(request_id, command, cwd) -> allowed``.
    #: ``None`` means the gate is not wired, and the command runs.
    approve: Callable[[str, str, str], Awaitable[bool]] | None = None


def tool_args(**values: Any) -> dict[str, Any]:
    """Drop unset optionals so the emitted ``ToolCall.args`` stays a clean JSON object."""
    return {key: value for key, value in values.items() if value is not None}


def clip_output(text: str, limit: int = TOOL_OUTPUT_LIMIT) -> tuple[str, bool]:
    """Clip a string for the wire and report whether anything was dropped."""
    if len(text) <= limit:
        return text, False
    return f"{text[:limit]}\n...[{len(text) - limit} characters truncated]", True


async def run_tool(
    ctx: ToolContext,
    name: str,
    tool_call_id: str,
    args: dict[str, Any],
    invoke: Callable[[], Awaitable[str]],
) -> str:
    """Announce, execute, and report one tool call, then return its full output string."""
    started = int(time.time() * 1000)
    await ctx.emit(
        "agent.tool_call",
        ToolCall(id=tool_call_id, name=name, args=args, started_at=started, agent=ctx.agent),
        session_id=ctx.session_id,
    )
    try:
        output = await invoke()
    except OrbitalError as exc:
        output = f"ERROR: {exc.detail or exc}"
    except Exception as exc:  # noqa: BLE001 - a tool must never break the agent loop
        output = f"ERROR: {type(exc).__name__}: {exc}"
    duration_ms = int(time.time() * 1000) - started
    ok = output.startswith("OK:")
    clipped, truncated = clip_output(output)
    await ctx.emit(
        "agent.tool_result",
        ToolResult(
            id=tool_call_id,
            name=name,
            ok=ok,
            duration_ms=duration_ms,
            output=clipped,
            truncated=truncated,
            error=None if ok else clipped,
        ),
        session_id=ctx.session_id,
    )
    return output
