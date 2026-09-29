"""The project registry: what the launcher creates, lists and opens.

Every test points the registry at a file of its own (``config.projects_file`` is patched, the way
``test_api.py`` patches ``env_file_path``), so nothing here reads or writes the user's real state
directory.
"""

from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

import httpx
import pytest

from orbital_backend import config
from orbital_backend.errors import NotFoundError, ToolError, WorkspaceError
from orbital_backend.services.projects import ProjectRegistry
from orbital_backend.services.workspace import Workspace


class _Clock:
    """A hand-wound epoch, so ordering by ``lastOpenedAt`` never races the wall clock."""

    def __init__(self, now: float = 1_000.0) -> None:
        self.now = now

    def time(self) -> float:
        return self.now


@pytest.fixture()
def registry_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "state" / "projects.json"
    monkeypatch.setattr(config, "projects_file", lambda: path)
    return path


@pytest.fixture()
def registry(registry_file: Path) -> ProjectRegistry:
    return ProjectRegistry()


@pytest.fixture()
def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    from orbital_backend.services import projects as projects_module

    fake = _Clock()
    monkeypatch.setattr(projects_module, "time", fake)
    return fake


@pytest.fixture()
def api_registry(registry_file: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectRegistry:
    """Point the routers at a registry backed by this test's file."""
    from orbital_backend.routes import project as project_routes
    from orbital_backend.routes import projects as projects_routes

    fresh = ProjectRegistry()
    monkeypatch.setattr(projects_routes, "projects", fresh)
    monkeypatch.setattr(project_routes, "projects", fresh)
    return fresh


@pytest.fixture()
def singleton_workspace(monkeypatch: pytest.MonkeyPatch) -> Workspace:
    """Hand the process-wide workspace back the way it was found; the routes share this instance."""
    from orbital_backend.services.workspace import workspace

    monkeypatch.setattr(workspace, "_root", workspace.root)
    monkeypatch.setattr(workspace, "_granted_roots", dict(workspace._granted_roots))
    return workspace


async def test_create_makes_the_directory_and_registers_it(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    entry = registry.create(str(tmp_path), "demo", "  a demo  ")

    folder = tmp_path / "demo"
    assert folder.is_dir()
    assert entry.name == "demo"
    assert Path(entry.path) == folder.resolve()
    assert entry.description == "a demo"
    assert entry.created_at == entry.last_opened_at > 0
    assert [item.id for item in registry.list()] == [entry.id]


async def test_a_blank_description_is_stored_as_null(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    assert registry.create(str(tmp_path), "demo", "   ").description is None


async def test_creating_a_registered_path_again_returns_the_same_entry(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    first = registry.create(str(tmp_path), "demo", "first")
    registry.record_open(first.path)

    again = registry.create(str(tmp_path), "demo", "second")

    assert again == registry.list()[0], "a second Create must not rewrite the entry"
    assert again.id == first.id
    assert again.description == "first"
    assert len(registry.list()) == 1


#: Names that are not one folder: blank, a path, a drive-qualified path, a traversal and an
#: over-long label. Create and edit must refuse exactly the same set.
BAD_NAMES = ["", "   ", "a/b", "a\\b", "C:demo", "..", "a..b", "x" * 81]


@pytest.mark.parametrize("name", BAD_NAMES)
async def test_create_rejects_a_name_that_is_not_one_folder(
    registry: ProjectRegistry, tmp_path: Path, name: str
) -> None:
    with pytest.raises(WorkspaceError):
        registry.create(str(tmp_path), name, None)


async def test_create_accepts_an_eighty_character_name(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    assert registry.create(str(tmp_path), "x" * 80, None).name == "x" * 80


async def test_create_rejects_a_missing_parent(registry: ProjectRegistry, tmp_path: Path) -> None:
    with pytest.raises(WorkspaceError):
        registry.create(str(tmp_path / "nope"), "demo", None)


async def test_create_rejects_a_parent_that_is_a_file(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    parent = tmp_path / "notes.txt"
    parent.write_text("x", encoding="utf-8")

    with pytest.raises(WorkspaceError):
        registry.create(str(parent), "demo", None)


async def test_create_rejects_a_file_where_the_folder_should_go(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    (tmp_path / "demo").write_text("x", encoding="utf-8")

    with pytest.raises(WorkspaceError):
        registry.create(str(tmp_path), "demo", None)


@pytest.mark.skipif(sys.platform != "win32", reason="only Windows rejects these characters")
async def test_create_reports_a_name_the_filesystem_refuses(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    """An unrepresentable folder name is the user's answer to fix, not a 500."""
    with pytest.raises(WorkspaceError):
        registry.create(str(tmp_path), "a<b", None)


async def test_create_rejects_an_over_long_description(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    with pytest.raises(ToolError):
        registry.create(str(tmp_path), "demo", "x" * 281)

    assert not (tmp_path / "demo").exists(), "a rejected request must not leave a folder behind"


async def test_create_stores_the_repository_and_the_strategy(
    registry: ProjectRegistry, registry_file: Path, tmp_path: Path
) -> None:
    entry = registry.create(
        str(tmp_path),
        "demo",
        None,
        repository="  https://github.com/orbital/demo.git  ",
        branch_strategy="github-flow",
    )

    assert entry.repository == "https://github.com/orbital/demo.git", "the URL is trimmed"
    assert entry.branch_strategy == "github-flow"
    restarted = ProjectRegistry().list()[0]
    assert (restarted.repository, restarted.branch_strategy) == (
        entry.repository,
        "github-flow",
    )
    written = json.loads(registry_file.read_text(encoding="utf-8"))
    assert written["projects"][0]["branchStrategy"] == "github-flow", "camelCase on disk"


async def test_create_accepts_a_repository_at_the_length_limit(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    url = "https://example.com/" + "x" * 280
    assert len(url) == 300

    assert (
        registry.create(str(tmp_path), "demo", None, repository=url, branch_strategy="trunk")
        .repository
        == url
    )


#: Repositories the sync phase could not push to: a bare host, a scheme Git does not clone over
#: and a local path. Create and edit must refuse exactly this set.
BAD_REPOSITORIES = [
    "example.com/team/demo",
    "git://github.com/team/demo.git",
    "C:\\repos\\demo",
]


@pytest.mark.parametrize("repository", BAD_REPOSITORIES)
async def test_create_rejects_a_repository_it_could_not_push_to(
    registry: ProjectRegistry, tmp_path: Path, repository: str
) -> None:
    with pytest.raises(ToolError) as refused:
        registry.create(str(tmp_path), "demo", None, repository=repository, branch_strategy="trunk")

    assert "https://" in str(refused.value), "the message names the forms that are accepted"


async def test_create_rejects_an_over_long_repository(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    with pytest.raises(ToolError):
        registry.create(
            str(tmp_path),
            "demo",
            None,
            repository="https://example.com/" + "x" * 300,
            branch_strategy="trunk",
        )

    assert not (tmp_path / "demo").exists(), "a rejected request must not leave a folder behind"


async def test_create_rejects_an_unknown_branching_strategy(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    with pytest.raises(ToolError) as refused:
        registry.create(
            str(tmp_path),
            "demo",
            None,
            repository="https://github.com/team/demo.git",
            branch_strategy="gitlab-flow",
        )

    assert "gitlab-flow" in str(refused.value)
    assert not (tmp_path / "demo").exists(), "a rejected request must not leave a folder behind"


async def test_create_rejects_a_repository_without_a_strategy(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    with pytest.raises(ToolError, match="choose a branching strategy"):
        registry.create(
            str(tmp_path), "demo", None, repository="https://github.com/team/demo.git"
        )

    assert not (tmp_path / "demo").exists(), "a rejected request must not leave a folder behind"


async def test_create_rejects_a_strategy_without_a_repository(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    with pytest.raises(ToolError, match="needs a repository"):
        registry.create(str(tmp_path), "demo", None, branch_strategy="trunk")

    assert not (tmp_path / "demo").exists(), "a rejected request must not leave a folder behind"


async def test_creating_a_registered_project_again_keeps_its_repository(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    """Create is idempotent: a second Create that names no repository must not drop the pair."""
    entry = registry.create(
        str(tmp_path),
        "demo",
        None,
        repository="https://github.com/a/one.git",
        branch_strategy="trunk",
    )

    again = registry.create(str(tmp_path), "demo", "second")

    assert again.id == entry.id
    assert again.repository == "https://github.com/a/one.git"
    assert again.branch_strategy == "trunk"


async def test_create_adds_a_repository_to_a_project_that_already_exists(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    entry = registry.create(str(tmp_path), "demo", None)

    again = registry.create(
        str(tmp_path),
        "demo",
        None,
        repository="https://github.com/team/demo.git",
        branch_strategy="git-flow",
    )

    assert again.id == entry.id
    assert (again.repository, again.branch_strategy) == (
        "https://github.com/team/demo.git",
        "git-flow",
    )
    assert ProjectRegistry().list()[0].branch_strategy == "git-flow", "the change is persisted"


async def test_forget_removes_the_entry_and_keeps_the_directory(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    entry = registry.create(str(tmp_path), "demo", None)
    folder = Path(entry.path)

    assert registry.forget(entry.id) == []
    assert registry.list() == []
    assert folder.is_dir(), "forgetting a project must not delete the user's files"

    restarted = ProjectRegistry()
    assert restarted.list() == []


async def test_forget_with_files_deletes_the_whole_tree(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    entry = registry.create(str(tmp_path), "demo", None)
    folder = Path(entry.path)
    (folder / "src").mkdir()
    (folder / "src" / "app.py").write_text("print(1)\n", encoding="utf-8")

    assert registry.forget(entry.id, delete_files=True) == []

    assert registry.list() == []
    assert not folder.exists(), "deleting a project must remove everything under it"
    assert ProjectRegistry().list() == []


async def test_forget_with_files_unregisters_a_directory_that_is_already_gone(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    entry = registry.create(str(tmp_path), "demo", None)
    shutil.rmtree(entry.path)

    assert registry.forget(entry.id, delete_files=True) == []

    assert registry.list() == []


async def test_a_deletion_that_fails_leaves_the_project_registered(
    registry: ProjectRegistry, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Files go before the entry, so a failure leaves the project listed and inspectable."""
    entry = registry.create(str(tmp_path), "demo", None)
    notes = Path(entry.path) / "notes.txt"
    notes.write_text("x", encoding="utf-8")

    def refuse(*_args: object, **_kwargs: object) -> None:
        raise OSError("the file is in use by another program")

    monkeypatch.setattr(shutil, "rmtree", refuse)

    with pytest.raises(ToolError) as failure:
        registry.forget(entry.id, delete_files=True)

    assert "the file is in use" in str(failure.value)
    assert [item.id for item in registry.list()] == [entry.id]
    assert notes.is_file()


@pytest.mark.parametrize("which", ["home", "root", "state", "checkout"])
async def test_deleting_a_folder_the_launcher_does_not_manage_is_refused(
    registry: ProjectRegistry,
    singleton_workspace: Workspace,
    monkeypatch: pytest.MonkeyPatch,
    which: str,
) -> None:
    """Home, a drive root, the state directory and this checkout may not be deleted."""
    targets = {
        "home": Path.home(),
        "root": Path(Path.cwd().anchor),
        "state": config.state_dir(),
        "checkout": Path(__file__).resolve().parents[2],
    }
    entry = registry.record_open(targets[which])

    def explode(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("a protected folder must be refused before anything is deleted")

    monkeypatch.setattr(shutil, "rmtree", explode)

    with pytest.raises(WorkspaceError):
        registry.forget(entry.id, delete_files=True)

    assert [item.id for item in registry.list()] == [entry.id]


@pytest.mark.parametrize("which", ["home", "root", "state", "checkout"])
async def test_forgetting_a_protected_folder_is_still_allowed(
    registry: ProjectRegistry,
    singleton_workspace: Workspace,
    which: str,
) -> None:
    """Removing a *list entry* destroys nothing, so the deletion guards must not apply to it.

    In development the checkout itself ends up in recents the first time it is opened; refusing to
    forget it would strand an entry the user can see and cannot clear.
    """
    targets = {
        "home": Path.home(),
        "root": Path(Path.cwd().anchor),
        "state": config.state_dir(),
        "checkout": Path(__file__).resolve().parents[2],
    }
    entry = registry.record_open(targets[which])

    assert registry.forget(entry.id, delete_files=False) == []
    assert registry.list() == []
    assert targets[which].exists(), "forgetting must never touch the folder"


async def test_forget_an_unknown_project_is_a_404(registry: ProjectRegistry) -> None:
    with pytest.raises(NotFoundError):
        registry.forget("nope")


async def test_update_changes_only_the_fields_it_is_given(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    entry = registry.create(str(tmp_path), "demo", "an old note")

    renamed = registry.update(entry.id, name="renamed")[0]
    assert renamed.name == "renamed"
    assert renamed.description == "an old note"
    assert renamed.favourite is False

    starred = registry.update(entry.id, favourite=True)[0]
    assert starred.name == "renamed"
    assert starred.favourite is True

    blanked = registry.update(entry.id, description="   ")[0]
    assert blanked.description is None, "a blank description is how the form clears one"
    assert blanked.favourite is True


async def test_update_an_unknown_project_is_a_404(registry: ProjectRegistry) -> None:
    with pytest.raises(NotFoundError):
        registry.update("nope", name="demo")


@pytest.mark.parametrize("name", BAD_NAMES)
async def test_update_refuses_a_name_that_is_not_one_folder(
    registry: ProjectRegistry, tmp_path: Path, name: str
) -> None:
    entry = registry.create(str(tmp_path), "demo", None)

    with pytest.raises(WorkspaceError):
        registry.update(entry.id, name=name)

    assert registry.list()[0].name == "demo", "a refused edit must leave the entry alone"


async def test_update_rejects_an_over_long_description(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    entry = registry.create(str(tmp_path), "demo", None)

    with pytest.raises(ToolError):
        registry.update(entry.id, description="x" * 281)

    assert registry.list()[0].description is None


async def test_update_needs_a_strategy_in_the_same_request_as_a_repository(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    entry = registry.create(str(tmp_path), "demo", None)

    with pytest.raises(ToolError, match="choose a branching strategy"):
        registry.update(entry.id, repository="https://github.com/team/demo.git")

    assert registry.list()[0].repository is None, "a refused edit must leave the entry alone"

    updated = registry.update(
        entry.id,
        repository="https://github.com/team/demo.git",
        branch_strategy="github-flow",
    )[0]
    assert (updated.repository, updated.branch_strategy) == (
        "https://github.com/team/demo.git",
        "github-flow",
    )


async def test_update_needs_a_repository_for_a_strategy(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    entry = registry.create(str(tmp_path), "demo", None)

    with pytest.raises(ToolError, match="needs a repository"):
        registry.update(entry.id, branch_strategy="trunk")

    assert registry.list()[0].branch_strategy is None


async def test_update_changing_only_the_strategy_keeps_the_repository(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    """The rules apply to the pair the project ends up with, not to the fields sent."""
    entry = registry.create(
        str(tmp_path),
        "demo",
        None,
        repository="https://github.com/team/demo.git",
        branch_strategy="trunk",
    )

    updated = registry.update(entry.id, branch_strategy="git-flow")[0]

    assert (updated.repository, updated.branch_strategy) == (
        "https://github.com/team/demo.git",
        "git-flow",
    )


async def test_update_clearing_the_repository_clears_the_strategy(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    entry = registry.create(
        str(tmp_path),
        "demo",
        None,
        repository="https://github.com/team/demo.git",
        branch_strategy="trunk",
    )

    cleared = registry.update(entry.id, repository="")[0]

    assert (cleared.repository, cleared.branch_strategy) == (None, None)
    restarted = ProjectRegistry().list()[0]
    assert (restarted.repository, restarted.branch_strategy) == (None, None)


@pytest.mark.parametrize("repository", BAD_REPOSITORIES)
async def test_update_rejects_a_repository_it_could_not_push_to(
    registry: ProjectRegistry, tmp_path: Path, repository: str
) -> None:
    entry = registry.create(
        str(tmp_path),
        "demo",
        None,
        repository="https://github.com/team/demo.git",
        branch_strategy="trunk",
    )

    with pytest.raises(ToolError):
        registry.update(entry.id, repository=repository, branch_strategy="trunk")

    assert registry.list()[0].repository == "https://github.com/team/demo.git"


async def test_update_rejects_an_unknown_branching_strategy(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    entry = registry.create(
        str(tmp_path),
        "demo",
        None,
        repository="https://github.com/team/demo.git",
        branch_strategy="trunk",
    )

    with pytest.raises(ToolError, match="gitlab-flow"):
        registry.update(entry.id, branch_strategy="gitlab-flow")

    assert registry.list()[0].branch_strategy == "trunk"


async def test_update_returns_a_snapshot_the_caller_cannot_mutate(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    entry = registry.create(str(tmp_path), "demo", None)

    registry.update(entry.id, name="renamed")[0].name = "tampered"

    assert registry.list()[0].name == "renamed"


async def test_a_favourite_survives_a_restart(
    registry: ProjectRegistry, registry_file: Path, tmp_path: Path
) -> None:
    entry = registry.create(str(tmp_path), "demo", None)

    registry.update(entry.id, favourite=True)

    assert ProjectRegistry().list()[0].favourite is True
    written = json.loads(registry_file.read_text(encoding="utf-8"))
    assert written["projects"][0]["favourite"] is True


async def test_a_registry_written_before_favourites_existed_reads_as_not_a_favourite(
    registry: ProjectRegistry, registry_file: Path, tmp_path: Path
) -> None:
    registry_file.parent.mkdir(parents=True, exist_ok=True)
    registry_file.write_text(
        json.dumps(
            {
                "projects": [
                    {
                        "id": "old",
                        "name": "demo",
                        "path": str(tmp_path),
                        "description": None,
                        "createdAt": 10,
                        "lastOpenedAt": 10,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    assert registry.list()[0].favourite is False


async def test_a_registry_written_before_repositories_existed_reads_as_neither(
    registry: ProjectRegistry, registry_file: Path, tmp_path: Path
) -> None:
    """An entry written before repositories and strategies existed still loads."""
    registry_file.parent.mkdir(parents=True, exist_ok=True)
    registry_file.write_text(
        json.dumps(
            {
                "projects": [
                    {
                        "id": "old",
                        "name": "demo",
                        "path": str(tmp_path),
                        "description": None,
                        "createdAt": 10,
                        "lastOpenedAt": 10,
                        "favourite": True,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    entry = registry.list()[0]

    assert entry.repository is None
    assert entry.branch_strategy is None


async def test_clear_recent_puts_the_entry_outside_the_recents_window(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    """Recents are the last 24 hours, so epoch zero is never inside one."""
    entry = registry.create(str(tmp_path), "demo", None)

    cleared = registry.update(entry.id, clear_recent=True)[0]

    assert cleared.last_opened_at == 0
    assert time.time() - cleared.last_opened_at > 24 * 3600
    assert ProjectRegistry().list()[0].last_opened_at == 0


async def test_list_is_most_recently_opened_first(
    registry: ProjectRegistry, clock: _Clock, tmp_path: Path
) -> None:
    alpha = registry.create(str(tmp_path), "alpha", None)
    clock.now += 5
    beta = registry.create(str(tmp_path), "beta", None)
    clock.now += 5
    gamma = registry.create(str(tmp_path), "gamma", None)

    assert [entry.id for entry in registry.list()] == [gamma.id, beta.id, alpha.id]

    clock.now += 5
    registry.record_open(alpha.path)

    assert [entry.id for entry in registry.list()] == [alpha.id, gamma.id, beta.id]


async def test_entries_opened_at_the_same_moment_are_ordered_by_name(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    registry.create(str(tmp_path), "beta", None)
    registry.create(str(tmp_path), "alpha", None)

    assert [entry.name for entry in registry.list()] == ["alpha", "beta"]


async def test_list_returns_snapshots_the_caller_cannot_mutate(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    registry.create(str(tmp_path), "demo", None)

    registry.list()[0].name = "tampered"

    assert registry.list()[0].name == "demo"


async def test_find_by_path_matches_the_registered_directory(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    entry = registry.create(str(tmp_path), "demo", None)

    found = registry.find_by_path(entry.path)

    assert found is not None
    assert found.id == entry.id


async def test_find_by_path_returns_none_for_a_directory_that_is_not_a_project(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    entry = registry.create(str(tmp_path), "demo", None)

    assert registry.find_by_path(str(tmp_path / "other")) is None
    assert registry.find_by_path(entry.path + "-not-quite") is None
    assert registry.find_by_path(str(tmp_path)) is None, "the parent is not the project"


async def test_an_opened_folder_joins_the_list(
    registry: ProjectRegistry, tmp_path: Path
) -> None:
    """Opening is what makes a project recent — including a folder the launcher never made.

    A folder opened from the title bar's File menu is a project to the person who opened it, and
    a launcher that forgets it the moment the app closes is one they stop trusting.
    """
    project = tmp_path / "opened-somewhere-else"
    project.mkdir()

    entry = registry.record_open(project)

    assert entry.name == "opened-somewhere-else"
    assert entry.description is None
    assert [item.id for item in registry.list()] == [entry.id]


async def test_a_missing_registry_reads_as_empty(registry: ProjectRegistry) -> None:
    assert registry.list() == []


@pytest.mark.parametrize(
    "payload",
    [
        "{not json",
        '{"projects": [{"id": "x"}]}',
        "[]",
        '{"projects": "nope"}',
    ],
)
async def test_a_corrupt_registry_reads_as_empty(
    registry: ProjectRegistry, registry_file: Path, payload: str
) -> None:
    registry_file.parent.mkdir(parents=True, exist_ok=True)
    registry_file.write_text(payload, encoding="utf-8")

    assert registry.list() == []


async def test_create_replaces_a_corrupt_registry(
    registry: ProjectRegistry, registry_file: Path, tmp_path: Path
) -> None:
    registry_file.parent.mkdir(parents=True, exist_ok=True)
    registry_file.write_text("{not json", encoding="utf-8")

    entry = registry.create(str(tmp_path), "demo", None)

    assert [item.id for item in ProjectRegistry().list()] == [entry.id]


async def test_the_registry_survives_a_restart(
    registry: ProjectRegistry, registry_file: Path, tmp_path: Path
) -> None:
    entry = registry.create(str(tmp_path), "demo", "kept")

    restarted = ProjectRegistry().list()

    assert [(item.id, item.name, item.description) for item in restarted] == [
        (entry.id, "demo", "kept")
    ]
    written = json.loads(registry_file.read_text(encoding="utf-8"))
    assert written["projects"][0]["lastOpenedAt"] == entry.last_opened_at, "camelCase on disk"


def test_the_registry_file_lives_in_the_configured_state_dir(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(config.settings, "state_dir", tmp_path)

    assert config.projects_file() == tmp_path / "projects.json"


def test_an_unset_state_dir_falls_back_to_the_per_user_data_directory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config.settings, "state_dir", None)

    fallback = config.default_state_dir()
    assert fallback.is_absolute()
    assert fallback == config.state_dir()
    assert config.projects_file() == fallback / "projects.json"


# --------------------------------------------------------------------------------------
# HTTP surface
# --------------------------------------------------------------------------------------


async def test_the_branch_strategies_endpoint_publishes_the_models(
    client: httpx.AsyncClient,
) -> None:
    response = await client.get("/api/branch-strategies")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"strategies"}
    strategies = body["strategies"]
    assert [strategy["id"] for strategy in strategies] == ["trunk", "github-flow", "git-flow"]
    assert set(strategies[0]) == {"id", "label", "summary", "branches", "workflow"}
    for strategy in strategies:
        assert strategy["label"] and strategy["summary"] and strategy["branches"]
        # The workflow is handed to the agents, so it has to name the branch work lands on.
        assert strategy["branches"].split(",")[0].strip() in strategy["workflow"]


async def test_every_published_strategy_is_one_a_project_can_be_created_with(
    client: httpx.AsyncClient, api_registry: ProjectRegistry, tmp_path: Path
) -> None:
    """The published list and the ids create accepts are the same list."""
    listed = await client.get("/api/branch-strategies")

    for strategy in listed.json()["strategies"]:
        created = await client.post(
            "/api/projects",
            json={
                "parent": str(tmp_path),
                "name": strategy["id"],
                "repository": "https://github.com/team/demo.git",
                "branchStrategy": strategy["id"],
            },
        )

        assert created.status_code == 200, strategy["id"]
        assert created.json()["project"]["branchStrategy"] == strategy["id"]


async def test_the_projects_endpoints_speak_the_wire_contract(
    client: httpx.AsyncClient, api_registry: ProjectRegistry, tmp_path: Path
) -> None:
    created = await client.post(
        "/api/projects",
        json={"parent": str(tmp_path), "name": "demo", "description": "  hi  "},
    )

    assert created.status_code == 200
    body = created.json()
    assert set(body) == {"project"}
    assert set(body["project"]) == {
        "id",
        "name",
        "path",
        "description",
        "createdAt",
        "lastOpenedAt",
        "favourite",
        "repository",
        "branchStrategy",
    }
    assert body["project"]["description"] == "hi"
    assert body["project"]["favourite"] is False
    assert body["project"]["repository"] is None
    assert body["project"]["branchStrategy"] is None

    listed = await client.get("/api/projects")
    assert listed.status_code == 200
    assert listed.json() == {"projects": [body["project"]]}

    deleted = await client.delete(f"/api/projects/{body['project']['id']}")
    assert deleted.status_code == 200
    assert deleted.json() == {"projects": []}
    assert (tmp_path / "demo").is_dir(), "deleting a project must not touch the folder"


async def test_creating_a_project_with_a_bad_name_is_a_400(
    client: httpx.AsyncClient, api_registry: ProjectRegistry, tmp_path: Path
) -> None:
    response = await client.post(
        "/api/projects",
        json={"parent": str(tmp_path), "name": "a/b", "description": None},
    )

    assert response.status_code == 400
    assert response.json()["detail"]


async def test_deleting_an_unknown_project_is_a_404(
    client: httpx.AsyncClient, api_registry: ProjectRegistry
) -> None:
    response = await client.delete("/api/projects/nope")

    assert response.status_code == 404
    assert response.json()["detail"]


async def _created_project(
    client: httpx.AsyncClient, parent: Path, name: str, description: str | None = None
) -> dict[str, str]:
    """Create a project over HTTP and hand back its wire entry."""
    response = await client.post(
        "/api/projects",
        json={"parent": str(parent), "name": name, "description": description},
    )
    assert response.status_code == 200
    return response.json()["project"]


async def test_patching_a_project_speaks_the_wire_contract(
    client: httpx.AsyncClient, api_registry: ProjectRegistry, tmp_path: Path
) -> None:
    first = await _created_project(client, tmp_path, "demo", "kept")
    await _created_project(client, tmp_path, "zeta")

    patched = await client.patch(
        f"/api/projects/{first['id']}",
        json={"name": "renamed", "favourite": True, "clearRecent": True},
    )

    assert patched.status_code == 200
    assert set(patched.json()) == {"projects"}
    entry = next(item for item in patched.json()["projects"] if item["id"] == first["id"])
    assert entry["name"] == "renamed"
    assert entry["favourite"] is True
    assert entry["lastOpenedAt"] == 0
    assert entry["description"] == "kept", "an omitted field must survive the edit"

    listed = await client.get("/api/projects")
    assert listed.json() == patched.json(), "PATCH lists what GET lists, in the same order"


async def test_patching_nothing_is_a_400(
    client: httpx.AsyncClient, api_registry: ProjectRegistry, tmp_path: Path
) -> None:
    project = await _created_project(client, tmp_path, "demo")

    response = await client.patch(f"/api/projects/{project['id']}", json={})

    assert response.status_code == 400
    assert response.json()["detail"]


async def test_patching_a_project_with_a_bad_name_is_a_400(
    client: httpx.AsyncClient, api_registry: ProjectRegistry, tmp_path: Path
) -> None:
    project = await _created_project(client, tmp_path, "demo")

    response = await client.patch(f"/api/projects/{project['id']}", json={"name": "a/b"})

    assert response.status_code == 400
    assert response.json()["detail"]
    assert api_registry.list()[0].name == "demo"


async def test_the_repository_endpoints_speak_the_wire_contract(
    client: httpx.AsyncClient, api_registry: ProjectRegistry, tmp_path: Path
) -> None:
    created = await client.post(
        "/api/projects",
        json={
            "parent": str(tmp_path),
            "name": "demo",
            "repository": "https://github.com/team/demo.git",
            "branchStrategy": "trunk",
        },
    )

    assert created.status_code == 200
    project = created.json()["project"]
    assert project["repository"] == "https://github.com/team/demo.git"
    assert project["branchStrategy"] == "trunk"
    assert (await client.get("/api/projects")).json() == {"projects": [project]}

    cleared = await client.patch(f"/api/projects/{project['id']}", json={"repository": ""})

    assert cleared.status_code == 200
    assert cleared.json()["projects"][0]["repository"] is None
    assert cleared.json()["projects"][0]["branchStrategy"] is None


async def test_patching_a_repository_without_a_strategy_is_a_400(
    client: httpx.AsyncClient, api_registry: ProjectRegistry, tmp_path: Path
) -> None:
    project = await _created_project(client, tmp_path, "demo")

    response = await client.patch(
        f"/api/projects/{project['id']}",
        json={"repository": "https://github.com/team/demo.git"},
    )

    assert response.status_code == 400
    assert "branching strategy" in response.json()["detail"]
    assert api_registry.list()[0].repository is None


async def test_patching_a_project_with_an_unknown_strategy_is_a_400(
    client: httpx.AsyncClient, api_registry: ProjectRegistry, tmp_path: Path
) -> None:
    project = await _created_project(client, tmp_path, "demo")

    response = await client.patch(
        f"/api/projects/{project['id']}",
        json={
            "repository": "https://github.com/team/demo.git",
            "branchStrategy": "gitlab-flow",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]
    assert api_registry.list()[0].branch_strategy is None


async def test_patching_an_unknown_project_is_a_404(
    client: httpx.AsyncClient, api_registry: ProjectRegistry
) -> None:
    response = await client.patch("/api/projects/nope", json={"favourite": True})

    assert response.status_code == 404
    assert response.json()["detail"]


async def test_deleting_a_project_removes_its_files_only_when_asked(
    client: httpx.AsyncClient, api_registry: ProjectRegistry, tmp_path: Path
) -> None:
    kept = await _created_project(client, tmp_path, "kept")
    kept_notes = Path(kept["path"]) / "notes.txt"
    kept_notes.write_text("x", encoding="utf-8")

    forgotten = await client.delete(f"/api/projects/{kept['id']}", params={"files": "false"})

    assert forgotten.status_code == 200
    assert forgotten.json() == {"projects": []}
    assert kept_notes.is_file(), "the default delete keeps the user's files"

    removed = await _created_project(client, tmp_path, "removed")
    removed_notes = Path(removed["path"]) / "src" / "app.py"
    removed_notes.parent.mkdir()
    removed_notes.write_text("print(1)\n", encoding="utf-8")

    deleted = await client.delete(f"/api/projects/{removed['id']}", params={"files": "true"})

    assert deleted.status_code == 200
    assert deleted.json() == {"projects": []}
    assert not Path(removed["path"]).exists()
    assert not removed_notes.exists(), "deleting with files must take the nested files too"


async def test_deleting_a_protected_folder_through_the_api_is_a_400(
    client: httpx.AsyncClient,
    api_registry: ProjectRegistry,
    singleton_workspace: Workspace,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entry = api_registry.record_open(config.state_dir())

    def explode(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("a protected folder must be refused before anything is deleted")

    monkeypatch.setattr(shutil, "rmtree", explode)

    response = await client.delete(f"/api/projects/{entry.id}", params={"files": "true"})

    assert response.status_code == 400
    assert response.json()["detail"]
    assert config.projects_file().exists()


async def test_the_docs_endpoint_returns_the_repository_readme(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/docs")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"markdown", "source"}
    assert body["source"] == "README.md"
    assert body["markdown"].lstrip().startswith("# Orbital")


async def test_the_docs_endpoint_falls_back_when_there_is_no_checkout(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A packaged sidecar ships without a README, and an empty help pane helps nobody."""
    from orbital_backend.routes import projects as projects_routes

    monkeypatch.setattr(projects_routes, "README_PATH", tmp_path / "missing" / "README.md")

    response = await client.get("/api/docs")

    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "built-in"
    assert body["markdown"].lstrip().startswith("# Orbital")
    for phase in ("plan", "design", "build", "test", "sync"):
        assert phase in body["markdown"].lower()
    assert "projects.json" in body["markdown"]


async def test_opening_a_registered_project_updates_last_opened_at(
    client: httpx.AsyncClient,
    api_registry: ProjectRegistry,
    singleton_workspace: Workspace,
    clock: _Clock,
    tmp_path: Path,
) -> None:
    entry = api_registry.create(str(tmp_path), "demo", None)
    clock.now += 10

    response = await client.post("/api/project/open", json={"path": entry.path})

    assert response.status_code == 200
    assert api_registry.list()[0].last_opened_at == entry.last_opened_at + 10


async def test_opening_an_unregistered_directory_registers_it(
    client: httpx.AsyncClient,
    api_registry: ProjectRegistry,
    singleton_workspace: Workspace,
    tmp_path: Path,
) -> None:
    """Opening is what makes a folder a project, whoever asked.

    The launcher's list is the workspaces the user has opened, not only the ones it created: a
    folder opened from the File menu is a project to the person who opened it, and the launcher
    would otherwise forget it the moment the app closes.
    """
    response = await client.post("/api/project/open", json={"path": str(tmp_path)})

    assert response.status_code == 200
    entries = api_registry.list()
    assert [Path(entry.path) for entry in entries] == [tmp_path.resolve()]
    assert entries[0].name == tmp_path.name


async def test_a_project_created_outside_allowed_roots_can_be_opened(
    client: httpx.AsyncClient,
    api_registry: ProjectRegistry,
    singleton_workspace: Workspace,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The desktop build pins ORBITAL_ALLOWED_ROOTS to its own data directory, so a project the
    user creates elsewhere must still open — and its neighbours must not."""
    app_data = tmp_path / "app-data"
    app_data.mkdir()
    monkeypatch.setattr(singleton_workspace, "allowed_roots", [str(app_data)])

    parent = tmp_path / "projects"
    parent.mkdir()
    created = await client.post(
        "/api/projects", json={"parent": str(parent), "name": "demo", "description": None}
    )
    project = Path(created.json()["project"]["path"])
    (project / "main.py").write_text("print(1)\n", encoding="utf-8")

    opened = await client.post("/api/project/open", json={"path": str(project)})
    assert opened.status_code == 200
    found = await client.get("/api/files/content", params={"path": "main.py"})
    assert found.status_code == 200

    # The grant is per opened directory, never per parent: a sibling the user has not opened is
    # still refused, even when it is sitting next to a project that is allowed.
    neighbour = parent / "other"
    neighbour.mkdir()
    (neighbour / "main.py").write_text("print(2)\n", encoding="utf-8")
    singleton_workspace.set_root(neighbour)
    refused = await client.get("/api/files/content", params={"path": "main.py"})
    assert refused.status_code == 400
    assert refused.json()["detail"]


# --------------------------------------------------------------------------------------
# Containment
# --------------------------------------------------------------------------------------


def _link_directory(link: Path, target: Path) -> None:
    """Point ``link`` at ``target``, or skip when this machine cannot create a link.

    A symlink needs developer mode on Windows, where a junction is the equivalent reparse point
    an ordinary user can make; containment has to refuse both.
    """
    try:
        link.symlink_to(target, target_is_directory=True)
        return
    except OSError:
        pass
    if sys.platform == "win32":
        import _winapi

        create_junction = getattr(_winapi, "CreateJunction", None)
        if create_junction is not None:
            try:
                create_junction(str(target), str(link))
                return
            except OSError:
                pass
    pytest.skip(f"cannot link {link} to {target}")


def _granted_space(tmp_path: Path) -> tuple[Workspace, Path]:
    app_data = tmp_path / "app-data"
    app_data.mkdir()
    project = tmp_path / "project"
    project.mkdir()
    (project / "seed.txt").write_text("x", encoding="utf-8")

    space = Workspace(allowed_roots=[str(app_data)])
    space.grant_root(project)
    space.set_root(project)
    return space, project


def test_a_granted_root_is_accepted_when_allowed_roots_is_set(tmp_path: Path) -> None:
    space, project = _granted_space(tmp_path)

    assert space.resolve("seed.txt") == (project / "seed.txt").resolve()


def test_a_granted_root_still_refuses_traversal_and_absolute_paths(tmp_path: Path) -> None:
    space, _project = _granted_space(tmp_path)
    secret = tmp_path / "secret.txt"
    secret.write_text("x", encoding="utf-8")

    with pytest.raises(WorkspaceError):
        space.resolve("../secret.txt")
    with pytest.raises(WorkspaceError):
        space.resolve(str(secret))


def test_a_granted_root_still_refuses_a_link_escape(tmp_path: Path) -> None:
    space, project = _granted_space(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("x", encoding="utf-8")
    _link_directory(project / "escape", outside)

    with pytest.raises(WorkspaceError):
        space.resolve("escape/secret.txt")
