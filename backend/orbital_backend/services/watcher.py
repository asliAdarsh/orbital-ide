"""Filesystem watching, built on watchfiles.

chokidar is a Node library and cannot run inside the Python sidecar; ``watchfiles`` is
the equivalent production watcher (the same one uvicorn's reloader uses), so this is a
deliberate substitution rather than a workaround. One watcher runs per session.
"""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path

from watchfiles import Change, awatch

from orbital_backend.errors import logger
from orbital_backend.events import bus
from orbital_backend.services.workspace import IGNORED_DIRS

_log = logger(__name__)

_KIND: dict[Change, str] = {
    Change.added: "created",
    Change.modified: "modified",
    Change.deleted: "deleted",
}
_DEBOUNCE_MS = 400
_STEP_MS = 100


class SessionWatcher:
    """One ``watchfiles`` task emitting ``file.changed`` for a single session."""

    def __init__(self, session_id: str, root: Path) -> None:
        self.session_id = session_id
        self.root = root
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(
                self._run(), name=f"orbital-watch-{self.session_id}"
            )

    async def stop(self) -> None:
        self._stop.set()
        task, self._task = self._task, None
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    def _ignored(self, path: str) -> bool:
        candidate = Path(path)
        try:
            parts = candidate.relative_to(self.root).parts
        except ValueError:
            parts = candidate.parts
        return any(part in IGNORED_DIRS for part in parts)

    def _relative(self, path: str) -> str:
        candidate = Path(path)
        try:
            return candidate.relative_to(self.root).as_posix()
        except ValueError:
            return candidate.as_posix()

    async def _run(self) -> None:
        try:
            async for changes in awatch(
                self.root,
                stop_event=self._stop,
                debounce=_DEBOUNCE_MS,
                step=_STEP_MS,
                watch_filter=lambda _change, path: not self._ignored(path),
            ):
                for change, path in changes:
                    await bus.emit(
                        "file.changed",
                        {"path": self._relative(path), "kind": _KIND[change]},
                        session_id=self.session_id,
                    )
        except asyncio.CancelledError:
            raise
        except Exception:
            _log.exception("file watcher for session %s stopped unexpectedly", self.session_id)


class WatcherRegistry:
    """Keeps at most one watcher per session."""

    def __init__(self) -> None:
        self._watchers: dict[str, SessionWatcher] = {}

    async def start(self, session_id: str, root: Path) -> SessionWatcher:
        previous = self._watchers.pop(session_id, None)
        if previous is not None:
            await previous.stop()
        watcher = SessionWatcher(session_id, root)
        self._watchers[session_id] = watcher
        watcher.start()
        return watcher

    async def stop(self, session_id: str) -> bool:
        watcher = self._watchers.pop(session_id, None)
        if watcher is None:
            return False
        await watcher.stop()
        return True

    async def stop_all(self) -> None:
        watchers = list(self._watchers.values())
        self._watchers.clear()
        for watcher in watchers:
            await watcher.stop()


watchers = WatcherRegistry()
