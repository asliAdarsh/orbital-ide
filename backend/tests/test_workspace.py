"""Path containment and workspace metadata — the security boundary of every file tool.

These tests fail for any implementation that simply joins the root and a relative path:
traversal, absolute paths, directory links and the allowed-roots list must all be refused.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from orbital_backend.errors import WorkspaceError
from orbital_backend.services.workspace import Workspace


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    (root / "src").mkdir(parents=True)
    (root / "src" / "app.py").write_text("print('hi')\n", encoding="utf-8")
    (root / "README.md").write_text("# demo\n", encoding="utf-8")
    return root


def _open(project: Path, allowed_roots: list[str] | None = None) -> Workspace:
    space = Workspace(allowed_roots=[] if allowed_roots is None else allowed_roots)
    space.set_root(project)
    return space


def _link_directory(link: Path, target: Path) -> None:
    """Create a directory link, or skip when the OS refuses to create one."""
    if os.name == "nt":
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            pytest.skip(f"cannot create a directory junction: {result.stderr.strip()}")
        return
    try:
        os.symlink(target, link, target_is_directory=True)
    except OSError as exc:  # pragma: no cover - depends on the host policy
        pytest.skip(f"cannot create a symlink: {exc}")


def test_resolve_maps_relative_paths_inside_the_root(project: Path) -> None:
    space = _open(project)
    assert space.resolve("src/app.py") == (project / "src" / "app.py").resolve()
    assert space.resolve("src") == (project / "src").resolve()
    assert space.resolve("") == project.resolve()


@pytest.mark.parametrize(
    "attempt",
    [
        "../outside.txt",
        "src/../../outside.txt",
        "..\\..\\Windows\\System32\\drivers\\etc\\hosts",
        "./../secret.txt",
        "src/..",
        "src/../../",
    ],
)
def test_resolve_rejects_parent_traversal(project: Path, attempt: str) -> None:
    space = _open(project)
    with pytest.raises(WorkspaceError):
        space.resolve(attempt)


@pytest.mark.parametrize("attempt", ["/etc/passwd", "/", "{absolute}"])
def test_resolve_rejects_absolute_paths(project: Path, tmp_path: Path, attempt: str) -> None:
    space = _open(project)
    target = attempt.format(absolute=str(tmp_path / "outside.txt"))
    with pytest.raises(WorkspaceError):
        space.resolve(target)


@pytest.mark.skipif(os.name != "nt", reason="UNC paths only exist on Windows")
def test_resolve_rejects_unc_paths(project: Path) -> None:
    space = _open(project)
    with pytest.raises(WorkspaceError):
        space.resolve(r"\\server\share\secret.txt")


def test_resolve_rejects_directory_links_escaping_the_root(project: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("classified\n", encoding="utf-8")
    _link_directory(project / "escape", outside)

    space = _open(project)
    with pytest.raises(WorkspaceError):
        space.resolve("escape/secret.txt")


def test_allowed_roots_reject_paths_outside_the_list(tmp_path: Path) -> None:
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    project = tmp_path / "project"
    project.mkdir()
    (project / "file.txt").write_text("x\n", encoding="utf-8")

    space = _open(project, allowed_roots=[str(allowed)])
    with pytest.raises(WorkspaceError):
        space.resolve("file.txt")


def test_allowed_roots_accept_paths_inside_the_list(tmp_path: Path) -> None:
    allowed = tmp_path / "allowed"
    project = allowed / "project"
    project.mkdir(parents=True)
    (project / "file.txt").write_text("x\n", encoding="utf-8")

    space = _open(project, allowed_roots=[str(allowed)])
    assert space.resolve("file.txt") == (project / "file.txt").resolve()


def test_rel_returns_posix_paths_and_rejects_escapes(project: Path, tmp_path: Path) -> None:
    space = _open(project)
    assert space.rel(project / "src" / "app.py") == "src/app.py"
    assert space.rel(project) == ""
    with pytest.raises(WorkspaceError):
        space.rel(tmp_path / "elsewhere.txt")


def test_resolve_dir_accepts_absolute_paths_inside_the_root(project: Path) -> None:
    space = _open(project)
    assert space.resolve_dir(None) == project.resolve()
    assert space.resolve_dir("") == project.resolve()
    assert space.resolve_dir(str(project / "src")) == (project / "src").resolve()
    with pytest.raises(WorkspaceError):
        space.resolve_dir(str(project.parent))
    with pytest.raises(WorkspaceError):
        space.resolve_dir("missing-dir")


def test_resolve_requires_an_open_project() -> None:
    space = Workspace(allowed_roots=[])
    with pytest.raises(WorkspaceError):
        space.resolve("file.txt")
    assert space.name() == ""
    assert space.exists() is False
    assert space.root is None


def test_set_root_rejects_missing_paths_and_files(tmp_path: Path) -> None:
    space = Workspace(allowed_roots=[])
    with pytest.raises(WorkspaceError):
        space.set_root(tmp_path / "missing")
    target = tmp_path / "a.txt"
    target.write_text("x\n", encoding="utf-8")
    with pytest.raises(WorkspaceError):
        space.set_root(target)
    with pytest.raises(WorkspaceError):
        space.set_root("")


def test_workspace_metadata_reflects_the_open_project(project: Path) -> None:
    space = _open(project)
    assert space.root == project.resolve()
    assert space.name() == "project"
    assert space.exists() is True
    assert space.is_writable() is True
