"""The project registry the dashboard launches projects from."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from orbital_backend.errors import WorkspaceError
from orbital_backend.models import (
    BRANCH_STRATEGIES,
    BranchStrategiesResponse,
    CreateProjectRequest,
    CreateProjectResponse,
    DocsResponse,
    ProjectsResponse,
    UpdateProjectRequest,
)
from orbital_backend.services.projects import projects

router = APIRouter(prefix="/api", tags=["projects"])

#: The repository README the help view renders. Located from this module rather than the working
#: directory, because the backend is started both from ``backend/`` and from the repository root.
README_PATH = Path(__file__).resolve().parents[3] / "README.md"

#: What the help view shows when there is no checkout to read a README from. A packaged sidecar
#: ships without one, and an empty pane would leave the user with nothing to read.
BUILT_IN_GUIDE = """\
# Orbital

Orbital takes an application from a brief to a pushed repository in five phases:

1. **Plan** — the architect researches the brief and writes `agent/plan.md`.
2. **Design** — the architect writes one real HTML page per screen under `agent/design/`.
3. **Build** — the code engine writes the application source into the project root.
4. **Test** — the QA agent runs the project's tests and writes `agent/test-report.md`.
5. **Sync** — the code engine commits and pushes to the configured remote.

A run is started from the launcher: pick a project, describe what you want, and the orchestrator
drives the specialists phase by phase, pausing for your approval on commands that need it. Every
token, tool call and terminal line streams back to the UI over one WebSocket, and the
orchestrator rewrites `agent/Agents.md` — the project state document — after each phase.

Projects are the folders you create or open from the launcher. The registry that lists them lives
in the backend's state directory (`ORBITAL_STATE_DIR`, otherwise the per-user data directory) as
`projects.json`.
"""


def _documentation() -> tuple[str, str]:
    """The README's markdown and the name of where it came from.

    An unreadable or missing file is not an error: the help view is a convenience, and a 404 there
    would only tell the user that documentation broke.
    """
    try:
        return README_PATH.read_text(encoding="utf-8"), "README.md"
    except OSError:
        return BUILT_IN_GUIDE, "built-in"


@router.get("/branch-strategies")
async def list_branch_strategies() -> BranchStrategiesResponse:
    """The branching models a project can be created or edited against.

    The client renders this list rather than carrying one of its own, so a strategy added here
    reaches the launcher without a frontend change.
    """
    return BranchStrategiesResponse(strategies=list(BRANCH_STRATEGIES))


@router.get("/projects")
async def list_projects() -> ProjectsResponse:
    """Every registered project, most recently opened first."""
    return ProjectsResponse(projects=projects.list())


@router.post("/projects")
async def create_project(body: CreateProjectRequest) -> CreateProjectResponse:
    """Create the folder and register it; the same folder asked for twice is not an error."""
    return CreateProjectResponse(
        project=projects.create(
            body.parent,
            body.name,
            body.description,
            repository=body.repository,
            branch_strategy=body.branch_strategy,
        )
    )


@router.patch("/projects/{project_id}")
async def update_project(project_id: str, body: UpdateProjectRequest) -> ProjectsResponse:
    """Edit a project's fields, or clear its last-opened time.

    Fields the client omits are left alone, so the edit dialog can send only what the user
    changed; a request that changes nothing is a mistake in the caller rather than a no-op.
    """
    if (
        body.name is None
        and body.description is None
        and body.favourite is None
        and body.clear_recent is None
        and body.repository is None
        and body.branch_strategy is None
    ):
        raise WorkspaceError(
            "nothing to update: send a name, description, favourite, repository, branchStrategy "
            "or clearRecent"
        )
    return ProjectsResponse(
        projects=projects.update(
            project_id,
            name=body.name,
            description=body.description,
            favourite=body.favourite,
            clear_recent=body.clear_recent,
            repository=body.repository,
            branch_strategy=body.branch_strategy,
        )
    )


@router.delete("/projects/{project_id}")
async def delete_project(project_id: str, files: bool = False) -> ProjectsResponse:
    """Forget a project. Its folder stays on disk unless ``files=true`` deletes the tree."""
    return ProjectsResponse(projects=projects.forget(project_id, delete_files=files))


@router.get("/docs")
async def read_docs() -> DocsResponse:
    """The repository README, or the built-in guide in a packaged build; never a 404."""
    markdown, source = _documentation()
    return DocsResponse(markdown=markdown, source=source)
