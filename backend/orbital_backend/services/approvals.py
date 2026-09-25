"""Holding shell commands for the user's decision.

The agent runs on the user's machine with the user's privileges, so a command is not executed until
the person watching agrees to it. The request goes out on the existing event bus and the tool awaits
a future; the WebSocket layer resolves it when the answer arrives.

Three rules keep this usable rather than maddening:

* **"Allow all in this run" is remembered per session** and cleared when the run ends, so a build
  phase does not stop on every ``npm install``.
* **The session permission mode is the user's standing choice**, set from the composer, and it
  outlives the run — see :meth:`ApprovalRegistry.set_permission`.
* **An unanswered request times out into a refusal.** Silence is not consent.
"""

from __future__ import annotations

import asyncio

from orbital_backend.errors import logger
from orbital_backend.events import bus
from orbital_backend.models import CommandRequest, Permission

_log = logger(__name__)

#: How long a request waits for an answer before it is treated as refused.
APPROVAL_TIMEOUT_SECONDS = 300.0


class ApprovalRegistry:
    """Session-scoped memory of the approval mode, remembered grants and unresolved requests."""

    def __init__(self) -> None:
        # Keyed by (session, tool-call id); the request is kept so a client that reconnects
        # can be told what is still being held.
        self._pending: dict[tuple[str, str], tuple[CommandRequest, asyncio.Future[bool]]] = {}
        #: The card's "allow all in this run": granted by an answer, dropped by :meth:`forget`.
        self._remembered: set[str] = set()
        #: The composer's permission mode, keyed by session. Deliberately *not* ``_remembered``:
        #: this is the standing "run commands without asking" the user chose in the UI, so it has
        #: to survive the end of a run, while ``_remembered`` must not. Only ``allow_all`` is
        #: stored; a missing session is ``ask``, which is also what switching back clears to.
        self._permission: dict[str, Permission] = {}

    def is_remembered(self, session_id: str) -> bool:
        return session_id in self._remembered

    def set_permission(self, session_id: str, permission: Permission | None) -> None:
        """Record the session's approval mode, replacing whatever it was.

        Switching back to ``ask`` restores the cards for the very next command, so ``ask`` is
        stored as absence rather than as another mode to compare against.
        """
        if permission is None or permission == "ask":
            self._permission.pop(session_id, None)
        else:
            self._permission[session_id] = permission

    def permission(self, session_id: str) -> Permission:
        """The session's approval mode. ``ask`` until the user says otherwise."""
        return self._permission.get(session_id, "ask")

    async def request(self, session_id: str, request: CommandRequest) -> bool:
        """Ask the user, and return whether the command may run.

        Returns ``True`` immediately when the session is allowed to run commands without asking,
        either because the user chose ``allow_all`` in the composer or because the card granted
        "allow all in this run".
        """
        if self.permission(session_id) == "allow_all" or self.is_remembered(session_id):
            return True

        future: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._pending[(session_id, request.id)] = (request, future)
        await bus.emit("agent.command_request", request, session_id=session_id)
        _log.info("awaiting approval for: %s", request.command[:120])
        try:
            return await asyncio.wait_for(future, timeout=APPROVAL_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            _log.warning("command approval timed out after %ss", APPROVAL_TIMEOUT_SECONDS)
            return False
        finally:
            self._pending.pop((session_id, request.id), None)

    def resolve(
        self, session_id: str, request_id: str, *, approved: bool, remember: bool
    ) -> bool:
        """Record the user's answer. Returns False when nothing was waiting on it."""
        if approved and remember:
            self._remembered.add(session_id)
        entry = self._pending.get((session_id, request_id))
        future = entry[1] if entry is not None else None
        if future is None or future.done():
            _log.debug("approval for %s arrived with nothing pending", request_id)
            return False
        future.set_result(approved)
        return True

    def pending(self, session_id: str) -> list[CommandRequest]:
        """Requests still waiting for an answer, oldest first.

        Sent with the session state so a client that reconnects mid-request learns that a
        command is being held for it. The request itself is emitted once, so without this a
        reconnected socket would wait forever on a decision it was never asked for.
        """
        return [
            request
            for (owner, _id), (request, _future) in self._pending.items()
            if owner == session_id
        ]

    def forget(self, session_id: str) -> None:
        """Drop a session's run-scoped blanket permission. Called when a run or discussion ends.

        Only the card's "allow all in this run" goes: the permission mode the user chose in the
        composer is a standing preference, and a run ending is not the user changing their mind.
        """
        self._remembered.discard(session_id)


approvals = ApprovalRegistry()
