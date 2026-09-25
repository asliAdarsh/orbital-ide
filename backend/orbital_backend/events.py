"""WebSocket fan-out: one process-wide event bus shared by every producer.

Producers call :meth:`EventBus.emit` from the event loop or
:meth:`EventBus.emit_threadsafe` from a worker thread (LangGraph runs tool nodes in
executor threads). Dead sockets are dropped from the registry instead of raising, so a
single vanished client can never abort a broadcast or an agent run.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import WebSocket

from orbital_backend import models
from orbital_backend.errors import logger
from orbital_backend.models import WsEventType

_log = logger(__name__)


class EventBus:
    """Registry of connected sockets plus the process-wide frame sequence counter."""

    def __init__(self) -> None:
        self._clients: dict[WebSocket, str | None] = {}
        self._seq = 0
        #: Per-session counters, so a client can tell "I missed frames of mine" from "another
        #: session was busy". Never pruned: a session id is a browser's, and the map holds one int
        #: per session the process has served.
        self._session_seq: dict[str, int] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        """Remember the loop that owns the sockets so threads can schedule onto it."""
        self._loop = loop

    def next_seq(self) -> int:
        """Return the next frame sequence number, monotonic for the whole process."""
        self._seq += 1
        return self._seq

    def next_session_seq(self, session_id: str | None) -> int | None:
        """Return the next sequence number for one session, or None for a session-less frame."""
        if session_id is None:
            return None
        self._session_seq[session_id] = self._session_seq.get(session_id, 0) + 1
        return self._session_seq[session_id]

    async def register(self, ws: WebSocket, session_id: str | None) -> None:
        """Subscribe ``ws`` to one session, or to every frame when ``session_id`` is None."""
        self._clients[ws] = session_id
        _log.debug("socket registered session=%s clients=%d", session_id, len(self._clients))

    async def unregister(self, ws: WebSocket) -> None:
        self._clients.pop(ws, None)

    async def emit(
        self,
        type_: WsEventType,
        payload: Any,
        *,
        session_id: str | None = None,
    ) -> None:
        """Broadcast one frame to every socket that subscribes to its session."""
        frame = models.event(
            type_,
            payload,
            session_id=session_id,
            seq=self.next_seq(),
            session_seq=self.next_session_seq(session_id),
        )
        await self._broadcast(frame, session_id)

    def emit_threadsafe(
        self,
        type_: WsEventType,
        payload: Any,
        *,
        session_id: str | None = None,
    ) -> None:
        """Schedule :meth:`emit` onto the socket loop from a non-async thread."""
        loop = self._loop
        if loop is None or loop.is_closed():
            _log.debug("dropping %s frame: event loop is not bound", type_)
            return
        try:
            asyncio.run_coroutine_threadsafe(
                self.emit(type_, payload, session_id=session_id), loop
            )
        except RuntimeError:
            _log.debug("dropping %s frame: loop refused the coroutine", type_)

    async def emit_terminal(
        self, session_id: str, command_id: str, channel: str, data: str
    ) -> None:
        """Stream one chunk of terminal output to a session."""
        await self.emit(
            "terminal.output",
            {"commandId": command_id, "channel": channel, "data": data},
            session_id=session_id,
        )

    async def _broadcast(self, frame: dict[str, Any], session_id: str | None) -> None:
        dead: list[WebSocket] = []
        for ws, subscription in list(self._clients.items()):
            if subscription is not None and session_id is not None and subscription != session_id:
                continue
            try:
                await ws.send_json(frame)
            except Exception:
                _log.debug("dropping a dead socket", exc_info=True)
                dead.append(ws)
        for ws in dead:
            self._clients.pop(ws, None)


bus = EventBus()
