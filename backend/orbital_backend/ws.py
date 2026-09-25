"""WebSocket endpoint: frame validation, dispatch and streamed command output.

A malformed or unknown frame produces an ``error`` frame and the connection stays open.
Frames that start long work (agent runs, terminal commands) are dispatched as background
tasks so the receive loop always stays responsive to ``ping`` and ``agent.cancel``.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Coroutine
from pathlib import Path
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from orbital_backend import models
from orbital_backend.errors import OrbitalError, logger
from orbital_backend.events import bus
from orbital_backend.models import ClientFrame
from orbital_backend.agents.runner import refresh_artifacts
from orbital_backend.routes.agents import cancel_run, chat_phase, run_phase
from orbital_backend.services.approvals import approvals
from orbital_backend.services.runner import StreamChunk, run_command
from orbital_backend.services.sessions import sessions, wire_state
from orbital_backend.services.watcher import watchers
from orbital_backend.services.workspace import workspace

router = APIRouter(tags=["websocket"])

_log = logger(__name__)

_tasks: set[asyncio.Task[None]] = set()
_running: dict[tuple[str, str], asyncio.Event] = {}


def _spawn(coro: Coroutine[Any, Any, None]) -> None:
    """Run a frame's long work in the background, keeping the loop free."""
    task = asyncio.create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def _send(ws: WebSocket, frame: dict[str, Any]) -> bool:
    try:
        await ws.send_json(frame)
        return True
    except (RuntimeError, OSError, WebSocketDisconnect):
        _log.debug("socket vanished while sending %s", frame.get("type"))
        return False


async def _send_error(ws: WebSocket, message: str, detail: str | None = None) -> None:
    await _send(ws, models.event("error", {"message": message, "detail": detail}, seq=bus.next_seq()))


def _require(value: str | None, field: str) -> str:
    if not value:
        raise OrbitalError(f"frame is missing field: {field}")
    return value


def _parse(raw: str) -> dict[str, Any] | None:
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


async def _run_terminal(
    session_id: str,
    command_id: str,
    command: str,
    cwd: Path,
    timeout: int | None,
    cancel: asyncio.Event,
) -> None:
    async def on_chunk(chunk: StreamChunk) -> None:
        await bus.emit_terminal(session_id, command_id, chunk.channel, chunk.data)

    key = (session_id, command_id)
    try:
        result = await run_command(
            command, cwd, timeout=timeout, on_chunk=on_chunk, cancel=cancel
        )
    finally:
        if _running.get(key) is cancel:
            _running.pop(key, None)
    await bus.emit(
        "terminal.exit",
        {"commandId": command_id, **result.model_dump(by_alias=True, mode="json")},
        session_id=session_id,
    )


async def _dispatch(ws: WebSocket, frame: ClientFrame) -> None:
    match frame.type:
        case "ping":
            await _send(
                ws,
                models.event("pong", {"ts": int(time.time() * 1000)}, seq=bus.next_seq()),
            )

        case "subscribe":
            session_id = _require(frame.session_id, "sessionId")
            await bus.register(ws, session_id)
            # Ask the disk before answering. The artefacts are files in the workspace, not facts
            # this process remembers: a reload, or a backend restart, must not make a plan that is
            # sitting on disk invisible to the window that is meant to show it.
            root = workspace.root
            if root is not None:
                await refresh_artifacts(session_id, root)
            state = wire_state(session_id)
            await _send(
                ws,
                models.event(
                    "session.state",
                    state,
                    session_id=session_id,
                    seq=bus.next_seq(),
                    session_seq=bus.next_session_seq(session_id),
                ),
            )

        case "agent.run":
            session_id = _require(frame.session_id, "sessionId")
            if frame.phase is None:
                raise OrbitalError("frame is missing field: phase")
            await run_phase(
                session_id,
                frame.phase,
                frame.prompt or "",
                _require(frame.project_path, "projectPath"),
                frame.auto_advance,
                frame.model,
                attachments=frame.attachments,
                reasoning_effort=frame.reasoning_effort,
                capabilities=frame.capabilities,
                permission=frame.permission,
            )

        case "agent.chat":
            session_id = _require(frame.session_id, "sessionId")
            if frame.phase is None:
                raise OrbitalError("frame is missing field: phase")
            await chat_phase(
                session_id,
                frame.phase,
                _require(frame.message, "message"),
                _require(frame.project_path, "projectPath"),
                frame.model,
                attachments=frame.attachments,
                reasoning_effort=frame.reasoning_effort,
                capabilities=frame.capabilities,
                permission=frame.permission,
            )

        case "agent.cancel":
            await cancel_run(_require(frame.session_id, "sessionId"))

        case "agent.approve":
            session_id = _require(frame.session_id, "sessionId")
            request_id = _require(frame.request_id, "requestId")
            if frame.approved is None:
                raise OrbitalError("frame is missing field: approved")
            resolved = approvals.resolve(
                session_id,
                request_id,
                approved=frame.approved,
                remember=frame.remember,
            )
            if resolved:
                await bus.emit(
                    "approval.resolved",
                    {
                        "requestId": request_id,
                        "approved": frame.approved,
                        "remember": frame.remember,
                    },
                    session_id=session_id,
                )
            else:
                _log.debug("approval for %s arrived with nothing pending", request_id)

        case "terminal.exec":
            session_id = _require(frame.session_id, "sessionId")
            command_id = _require(frame.command_id, "commandId")
            command = _require(frame.command, "command")
            cwd = workspace.resolve_dir(frame.cwd)
            cancel = asyncio.Event()
            _running[(session_id, command_id)] = cancel
            _spawn(_run_terminal(session_id, command_id, command, cwd, frame.timeout, cancel))

        case "terminal.cancel":
            session_id = _require(frame.session_id, "sessionId")
            command_id = _require(frame.command_id, "commandId")
            running = _running.get((session_id, command_id))
            if running is None:
                _log.debug("no running command %s in session %s", command_id, session_id)
            else:
                running.set()

        case "files.watch":
            session_id = _require(frame.session_id, "sessionId")
            await watchers.start(session_id, workspace.resolve_dir(frame.root))

        case _:
            await _send_error(ws, f"unknown frame type: {frame.type}")


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                break
            data = _parse(raw)
            if data is None:
                await _send_error(websocket, "malformed frame", "frame is not a JSON object")
                continue
            try:
                frame = ClientFrame.model_validate(data)
            except ValidationError as exc:
                await _send_error(websocket, "invalid frame", exc.errors(include_url=False).__repr__())
                continue
            try:
                await _dispatch(websocket, frame)
            except OrbitalError as exc:
                await _send_error(websocket, exc.detail)
            except Exception as exc:
                _log.exception("frame dispatch failed")
                await _send_error(websocket, "internal error", str(exc))
    finally:
        await bus.unregister(websocket)
        _log.debug("socket closed")
