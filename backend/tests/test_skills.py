"""Skills: the markdown instruction files a composer lists and reads.

Both folders are the user's own files, so the tests that matter are the tolerant ones: a file
with front-matter, a file without it, and a file that is malformed but must not take the list
down with it.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from orbital_backend.services.workspace import workspace

pytestmark = pytest.mark.asyncio

FRONT_MATTER = """\
---
name: Review a diff
description: Check a change against the project's conventions.
---

Read the diff and list every place it breaks a convention.
"""

PLAIN = """\
# Deploy notes

Run the release job by hand when the pipeline is red.
"""


def _workspace_skills(project: Path, **files: str) -> Path:
    """Put markdown files in a project's own skills folder."""
    folder = project / ".orbital" / "skills"
    folder.mkdir(parents=True, exist_ok=True)
    for name, text in files.items():
        (folder / name).write_text(text, encoding="utf-8")
    return folder


def _project(tmp_path: Path, name: str = "project") -> Path:
    project = tmp_path / name
    project.mkdir(parents=True, exist_ok=True)
    return project


async def _listed(client: httpx.AsyncClient, project: Path | None = None) -> list[dict[str, str]]:
    params = {} if project is None else {"workspace": str(project)}
    response = await client.get("/api/skills", params=params)
    assert response.status_code == 200, response.text
    return response.json()["skills"]


async def _read(
    client: httpx.AsyncClient, skill_id: str, project: Path | None = None
) -> httpx.Response:
    params = {} if project is None else {"workspace": str(project)}
    return await client.get(f"/api/skills/{skill_id}", params=params)


async def test_a_skill_with_front_matter_is_listed_and_read(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    project = _project(tmp_path)
    _workspace_skills(project, **{"review.md": FRONT_MATTER})

    listed = await _listed(client, project)

    assert len(listed) == 1
    skill = listed[0]
    assert skill["id"] == "workspace:review"
    assert skill["name"] == "Review a diff"
    assert skill["description"] == "Check a change against the project's conventions."
    assert skill["source"] == "workspace"
    assert skill["path"] == str(project / ".orbital" / "skills" / "review.md")

    body = (await _read(client, "workspace:review", project)).json()
    assert body["skill"]["id"] == "workspace:review"
    assert body["body"].startswith("Read the diff")
    # The header is metadata, not instructions: putting it in the prompt would send `name:` to the
    # model on every use of the skill.
    assert "name:" not in body["body"]


async def test_a_skill_without_front_matter_falls_back_to_the_file(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    project = _project(tmp_path)
    _workspace_skills(project, **{"deploy.md": PLAIN})

    skill = (await _listed(client, project))[0]

    assert skill["id"] == "workspace:deploy"
    assert skill["name"] == "deploy"
    assert skill["description"] == "# Deploy notes"

    body = (await _read(client, "workspace:deploy", project)).json()
    assert body["body"].startswith("# Deploy notes")


async def test_a_quoted_or_empty_header_value_falls_back_too(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    project = _project(tmp_path)
    _workspace_skills(
        project,
        **{
            "quoted.md": '---\nname: "Trim the log"\ndescription:\n---\n\nCut the noise.\n',
        },
    )

    skill = (await _listed(client, project))[0]

    assert skill["name"] == "Trim the log"
    # An empty value says no more than a missing one does.
    assert skill["description"] == "Cut the noise."


async def test_the_users_skills_are_listed_beside_the_workspaces(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    """The two folders may hold a file of the same name, and each keeps its own body."""
    project = _project(tmp_path)
    _workspace_skills(project, **{"review.md": FRONT_MATTER})
    user_folder = tmp_path / "skills"
    user_folder.mkdir()
    (user_folder / "review.md").write_text("---\nname: My review\n---\n\nMine.\n", encoding="utf-8")

    listed = await _listed(client, project)

    assert {skill["id"] for skill in listed} == {"workspace:review", "user:review"}
    assert {skill["source"] for skill in listed} == {"workspace", "user"}
    assert (await _read(client, "user:review", project)).json()["body"] == "Mine."
    assert (await _read(client, "workspace:review", project)).json()["body"].startswith("Read the")


async def test_a_malformed_skill_is_skipped_and_the_others_are_still_listed(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    project = _project(tmp_path)
    folder = _workspace_skills(
        project,
        **{
            "good.md": FRONT_MATTER,
            # An opening fence with no closing one: a header its author never finished, which must
            # not be read as the body either.
            "unclosed.md": "---\nname: Never finished\n\nSome text.\n",
        },
    )
    (folder / "not-text.md").write_bytes(b"\xff\xfe\x00\x01 not utf-8 at all")

    listed = await _listed(client, project)

    assert [skill["id"] for skill in listed] == ["workspace:good"]
    assert (await _read(client, "workspace:unclosed", project)).status_code == 404
    assert (await _read(client, "workspace:not-text", project)).status_code == 404


async def test_the_open_projects_skills_are_listed_when_no_workspace_is_named(
    client: httpx.AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path)
    _workspace_skills(project, **{"review.md": FRONT_MATTER})
    monkeypatch.setattr(workspace, "_root", project)

    skills = await _listed(client)

    assert [skill["id"] for skill in skills] == ["workspace:review"]


async def test_an_unknown_skill_is_a_404(client: httpx.AsyncClient, tmp_path: Path) -> None:
    """Also the shape a client gets for an id with no source in it, rather than a guess."""
    project = _project(tmp_path)

    responses = [
        await _read(client, "workspace:missing", project),
        await _read(client, "nonsense", project),
    ]

    assert [response.status_code for response in responses] == [404, 404]
