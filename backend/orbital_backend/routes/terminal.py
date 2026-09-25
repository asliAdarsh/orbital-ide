"""One-shot REST command execution; the WebSocket route streams instead."""

from __future__ import annotations

from fastapi import APIRouter

from orbital_backend import config
from orbital_backend.models import CommandResult, ExecRequest
from orbital_backend.services.runner import run_command
from orbital_backend.services.workspace import workspace

router = APIRouter(prefix="/api/terminal", tags=["terminal"])


@router.post("/exec")
async def exec_command(body: ExecRequest) -> CommandResult:
    settings = config.settings
    cwd = workspace.resolve_dir(body.cwd)
    return await run_command(
        body.command,
        cwd,
        timeout=body.timeout or settings.command_timeout,
        max_bytes=settings.max_output_bytes,
    )
