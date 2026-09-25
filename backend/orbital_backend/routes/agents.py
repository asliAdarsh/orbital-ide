"""Agent run control: the REST mirror of the WebSocket agent frames.

All agent logic lives in :mod:`orbital_backend.agents.runner`; this module only prepares
session state, schedules the run and normalises failures into session state.
"""

from __future__ import annotations

import asyncio
from functools import partial

from fastapi import APIRouter

from orbital_backend.agents import runner as agent_runner
from orbital_backend.errors import logger
from orbital_backend.models import (
    ChatTurnRequest,
    OkResponse,
    Permission,
    Phase,
    PhaseStatus,
    RunAccepted,
    RunAgentRequest,
    RunStatus,
    SessionRef,
    SessionState,
    SessionsResponse,
    validate_capabilities,
    validate_reasoning_effort,
)
from orbital_backend.services.sessions import sessions
from orbital_backend.services.workspace import workspace

router = APIRouter(prefix="/api", tags=["agents"])

_log = logger(__name__)


def _on_run_finished(session_id: str, task: asyncio.Task[None]) -> None:
    """Surface an agent crash: the runner reports its own errors, this is the safety net."""
    if task.cancelled():
        return
    error = task.exception()
    if error is None:
        return
    _log.error("agent run for session %s failed", session_id, exc_info=error)
    sessions.set_status(session_id, RunStatus.ERROR)
    sessions.set_error(session_id, str(error))


async def run_phase(
    session_id: str,
    phase: Phase,
    prompt: str,
    project_path: str,
    auto_advance: bool,
    model: str | None = None,
    *,
    attachments: list[str] | None = None,
    reasoning_effort: str | None = None,
    capabilities: list[str] | None = None,
    permission: Permission | None = None,
) -> RunAccepted:
    """Mark the phase running and hand the run to the agent runtime in the background."""
    # Checked before anything is scheduled: an unknown effort is the caller's mistake and must
    # come back as a refusal, not as a run that quietly ignores what it was asked for.
    effort = validate_reasoning_effort(reasoning_effort)
    # The same for an unknown capability, which is worse: dropping it would run the agent with
    # every tool the caller meant to withhold.
    enabled = validate_capabilities(capabilities)
    if project_path:
        workspace.set_root(project_path)
    sessions.ensure(session_id)
    sessions.set_project_path(session_id, project_path or None)
    sessions.set_active_phase(session_id, phase)
    sessions.set_phase_status(session_id, phase, PhaseStatus.RUNNING)
    sessions.set_status(session_id, RunStatus.RUNNING)
    sessions.set_error(session_id, None)

    task = asyncio.create_task(
        agent_runner.start_run(
            session_id,
            phase,
            prompt,
            project_path,
            auto_advance,
            model,
            attachments=attachments,
            reasoning_effort=effort,
            capabilities=enabled,
            permission=permission,
        ),
        name=f"orbital-agent-{session_id}",
    )
    task.add_done_callback(partial(_on_run_finished, session_id))
    return RunAccepted(session_id=session_id, status=RunStatus.RUNNING)


async def chat_phase(
    session_id: str,
    phase: Phase,
    message: str,
    project_path: str,
    model: str | None = None,
    *,
    attachments: list[str] | None = None,
    reasoning_effort: str | None = None,
    capabilities: list[str] | None = None,
    permission: Permission | None = None,
) -> RunAccepted:
    """Hand one conversational turn to the agent runtime.

    Deliberately leaves phase status alone: a discussion is not a phase run, so a phase that has
    already produced its artefact must not be knocked back to "running".
    """
    effort = validate_reasoning_effort(reasoning_effort)
    enabled = validate_capabilities(capabilities)
    if project_path:
        workspace.set_root(project_path)
    sessions.ensure(session_id)
    sessions.set_project_path(session_id, project_path or None)
    sessions.set_active_phase(session_id, phase)
    sessions.set_status(session_id, RunStatus.RUNNING)
    sessions.set_error(session_id, None)

    task = asyncio.create_task(
        agent_runner.start_chat(
            session_id,
            phase,
            message,
            project_path,
            model,
            attachments=attachments,
            reasoning_effort=effort,
            capabilities=enabled,
            permission=permission,
        ),
        name=f"orbital-chat-{session_id}",
    )
    task.add_done_callback(partial(_on_run_finished, session_id))
    return RunAccepted(session_id=session_id, status=RunStatus.RUNNING)


async def cancel_run(session_id: str) -> bool:
    """Cancel the in-flight run for ``session_id`` and record the new status."""
    cancelled = await agent_runner.cancel_run(session_id)
    if cancelled:
        sessions.set_status(session_id, RunStatus.CANCELLED)
    return cancelled


@router.post("/agents/run")
async def start_run(body: RunAgentRequest) -> RunAccepted:
    return await run_phase(
        body.session_id,
        body.phase,
        body.prompt,
        body.project_path,
        body.auto_advance,
        body.model,
        attachments=body.attachments,
        reasoning_effort=body.reasoning_effort,
        capabilities=body.capabilities,
        permission=body.permission,
    )


@router.post("/agents/chat")
async def start_chat(body: ChatTurnRequest) -> RunAccepted:
    """One conversational turn with a phase's specialist — no orchestration and no artefact."""
    return await chat_phase(
        body.session_id,
        body.phase,
        body.message,
        body.project_path,
        body.model,
        attachments=body.attachments,
        reasoning_effort=body.reasoning_effort,
        capabilities=body.capabilities,
        permission=body.permission,
    )


@router.post("/agents/cancel")
async def cancel_agent(body: SessionRef) -> OkResponse:
    return OkResponse(ok=await cancel_run(body.session_id))


@router.get("/agents/session/{session_id}")
async def get_session(session_id: str) -> SessionState:
    return sessions.ensure(session_id)


@router.get("/sessions")
async def list_sessions() -> SessionsResponse:
    return SessionsResponse(sessions=sessions.list())
