"""Command execution with live streaming and process-tree termination.

``run_command`` never raises for a failing command: a non-zero exit code is data, and
:attr:`CommandResult.error` is reserved for the case where the process could not be
launched at all.
"""

from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from orbital_backend import config
from orbital_backend.errors import logger
from orbital_backend.models import CommandResult

_log = logger(__name__)

_READ_SIZE = 32768
_KILL_GRACE_SECONDS = 5.0


@dataclass(slots=True)
class StreamChunk:
    """One slice of process output handed to the ``on_chunk`` callback."""

    channel: str
    data: str


@dataclass(slots=True)
class _Capture:
    """Shared character budget: stdout and stderr count against one ``max_bytes`` total."""

    remaining: int
    truncated: bool = False

    def take(self, text: str) -> str:
        if not text:
            return ""
        if self.remaining <= 0:
            self.truncated = True
            return ""
        if len(text) > self.remaining:
            kept = text[: self.remaining]
            self.remaining = 0
            self.truncated = True
            return kept
        self.remaining -= len(text)
        return text


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _platform_kwargs() -> dict[str, object]:
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {"start_new_session": True}


async def _read_stream(
    stream: asyncio.StreamReader | None,
    channel: str,
    capture: _Capture,
    sink: list[str],
    on_chunk: Callable[[StreamChunk], Awaitable[None]] | None,
) -> None:
    if stream is None:
        return
    while True:
        chunk = await stream.read(_READ_SIZE)
        if not chunk:
            return
        text = capture.take(chunk.decode("utf-8", errors="replace"))
        if not text:
            continue
        sink.append(text)
        if on_chunk is None:
            continue
        try:
            await on_chunk(StreamChunk(channel=channel, data=text))
        except Exception:
            _log.debug("stream callback failed for %s", channel, exc_info=True)


async def _kill_tree(proc: asyncio.subprocess.Process) -> None:
    """Kill the process and every descendant it spawned."""
    if proc.returncode is not None:
        return
    try:
        if os.name == "nt":
            killer = await asyncio.create_subprocess_exec(
                "taskkill",
                "/F",
                "/T",
                "/PID",
                str(proc.pid),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            await killer.wait()
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except OSError:
        _log.debug("process tree kill failed for pid %s", proc.pid, exc_info=True)
    try:
        await asyncio.wait_for(proc.wait(), timeout=_KILL_GRACE_SECONDS)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()


async def _drain(tasks: list[asyncio.Task[None]]) -> None:
    """Wait for the reader tasks; a child that leaked a pipe must not hang the call."""
    try:
        await asyncio.wait_for(
            asyncio.gather(*tasks, return_exceptions=True), timeout=_KILL_GRACE_SECONDS
        )
    except asyncio.TimeoutError:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def run_command(
    command: str,
    cwd: Path,
    *,
    timeout: int | None = None,
    max_bytes: int | None = None,
    on_chunk: Callable[[StreamChunk], Awaitable[None]] | None = None,
    env: dict[str, str] | None = None,
    cancel: asyncio.Event | None = None,
    stdin_data: bytes | None = None,
) -> CommandResult:
    """Run ``command`` through the platform shell, streaming output as it arrives.

    Setting ``cancel`` kills the process tree early and returns a result with
    ``cancelled`` set — the terminal panel's stop button. ``stdin_data`` is written and
    closed immediately, which lets callers hand user text to a command without any
    shell quoting (``git commit -F -``).
    """
    settings = config.settings
    limit = settings.max_output_bytes if max_bytes is None else max_bytes
    effective_timeout = settings.command_timeout if timeout is None else timeout
    if effective_timeout is not None and effective_timeout <= 0:
        effective_timeout = None
    started = time.monotonic()

    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            cwd=str(cwd),
            stdin=(
                asyncio.subprocess.PIPE
                if stdin_data is not None
                else asyncio.subprocess.DEVNULL
            ),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=None if env is None else {**os.environ, **env},
            **_platform_kwargs(),
        )
    except OSError as exc:
        return CommandResult(
            command=command,
            cwd=str(cwd),
            duration_ms=_elapsed_ms(started),
            error=f"could not launch command: {exc}",
        )

    if stdin_data is not None and proc.stdin is not None:
        try:
            proc.stdin.write(stdin_data)
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            _log.debug("command closed stdin before reading its input")
        finally:
            proc.stdin.close()

    capture = _Capture(remaining=limit)
    stdout: list[str] = []
    stderr: list[str] = []
    readers = [
        asyncio.create_task(_read_stream(proc.stdout, "stdout", capture, stdout, on_chunk)),
        asyncio.create_task(_read_stream(proc.stderr, "stderr", capture, stderr, on_chunk)),
    ]

    waiters: set[asyncio.Future[Any]] = {asyncio.ensure_future(proc.wait())}
    cancel_waiter: asyncio.Task[bool] | None = None
    if cancel is not None:
        cancel_waiter = asyncio.ensure_future(cancel.wait())
        waiters.add(cancel_waiter)

    cancelled = False
    timed_out = False
    done, pending = await asyncio.wait(
        waiters, timeout=effective_timeout, return_when=asyncio.FIRST_COMPLETED
    )
    if not done:
        timed_out = True
        await _kill_tree(proc)
    elif cancel_waiter is not None and cancel_waiter in done and proc.returncode is None:
        cancelled = True
        await _kill_tree(proc)
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)

    await _drain(readers)

    return CommandResult(
        command=command,
        cwd=str(cwd),
        exit_code=proc.returncode,
        stdout="".join(stdout),
        stderr="".join(stderr),
        duration_ms=_elapsed_ms(started),
        truncated=capture.truncated,
        timed_out=timed_out,
        cancelled=cancelled,
    )
