"""Skill endpoints: the markdown instructions a composer can turn into a prompt.

Read-only in both directions — listing reads the two folders, and reading one returns the body a
client inserts into the composer. Nothing here writes or executes a skill.
"""

from __future__ import annotations

from fastapi import APIRouter

from orbital_backend.models import SkillResponse, SkillsResponse
from orbital_backend.services.skills import skills

router = APIRouter(prefix="/api", tags=["skills"])


@router.get("/skills")
async def list_skills(workspace: str | None = None) -> SkillsResponse:
    """The skills a chat in ``workspace`` can use, or the open project's when none is named."""
    return SkillsResponse(skills=skills.list(workspace))


@router.get("/skills/{skill_id}")
async def read_skill(skill_id: str, workspace: str | None = None) -> SkillResponse:
    """One skill's body. A workspace skill's id is only unique within its workspace, so a client
    listing a folder other than the open project must name that folder here too."""
    found, body = skills.read(skill_id, workspace)
    return SkillResponse(skill=found, body=body)
