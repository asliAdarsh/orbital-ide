"""Project lifecycle and file endpoints."""

from __future__ import annotations

import os
import re
from pathlib import Path

from fastapi import APIRouter, Query

from orbital_backend.errors import NotFoundError, WorkspaceError
from orbital_backend.models import (
    FileContent,
    FileNode,
    OkResponse,
    OpenProjectRequest,
    ProjectResponse,
    SearchHit,
    SearchResponse,
    TreeResponse,
    WriteFileRequest,
)
from orbital_backend.routes.git import read_git_status
from orbital_backend.services.projects import projects
from orbital_backend.services.search import search_workspace
from orbital_backend.services.workspace import IGNORED_DIRS, require_root, workspace

router = APIRouter(prefix="/api", tags=["project"])

_READ_LIMIT = 200_000
_TREE_DEFAULT_DEPTH = 3
_TREE_MAX_DEPTH = 8
_SKIP_NAMES = frozenset({".DS_Store", "Thumbs.db", "desktop.ini"})

_LANGUAGES: dict[str, str] = {
    ".c": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".cs": "csharp",
    ".css": "css",
    ".go": "go",
    ".h": "c",
    ".hpp": "cpp",
    ".html": "html",
    ".htm": "html",
    ".java": "java",
    ".js": "javascript",
    ".json": "json",
    ".jsx": "javascript",
    ".kt": "kotlin",
    ".lua": "lua",
    ".md": "markdown",
    ".mjs": "javascript",
    ".php": "php",
    ".pl": "perl",
    ".py": "python",
    ".rb": "ruby",
    ".rs": "rust",
    ".scss": "scss",
    ".sh": "shell",
    ".sql": "sql",
    ".svelte": "html",
    ".swift": "swift",
    ".toml": "ini",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".vue": "html",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
}


def _language_for(path: str | Path) -> str:
    return _LANGUAGES.get(Path(path).suffix.lower(), "plaintext")


async def _project_payload() -> ProjectResponse:
    root = workspace.root
    return ProjectResponse(
        project_path=None if root is None else str(root),
        name=workspace.name() or None,
        writable=workspace.is_writable(),
        git=await read_git_status(),
    )


def _children(directory: Path) -> list[Path]:
    entries: list[Path] = []
    try:
        for entry in directory.iterdir():
            if entry.name in _SKIP_NAMES:
                continue
            if entry.is_symlink() and entry.is_dir():
                continue
            entries.append(entry)
    except OSError:
        return []
    entries.sort(key=lambda entry: (not entry.is_dir(), entry.name.lower()))
    return entries


def _directory_key(path: Path) -> str:
    return os.path.normcase(str(path.resolve()))


def _build_node(path: Path, root: Path, remaining: int, seen: set[str]) -> FileNode:
    relative = "" if path == root else path.relative_to(root).as_posix()
    if path.is_dir():
        if path != root:
            if path.name in IGNORED_DIRS:
                return FileNode(
                    name=path.name, path=relative, type="directory", ignored=True
                )
            key = _directory_key(path)
            # A junction or symlinked parent can lead back into the tree; stop there.
            if key in seen:
                return FileNode(
                    name=path.name, path=relative, type="directory", ignored=True
                )
            seen.add(key)
        node = FileNode(name=path.name or root.name, path=relative, type="directory")
        if remaining <= 0:
            return node
        node.children = [_build_node(child, root, remaining - 1, seen) for child in _children(path)]
        return node
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    return FileNode(name=path.name, path=relative, type="file", size=size)


@router.get("/project")
async def get_project() -> ProjectResponse:
    return await _project_payload()


@router.post("/project/open")
async def open_project(body: OpenProjectRequest) -> ProjectResponse:
    root = workspace.set_root(body.path)
    # Opening is what makes a project "recent" — whoever asked for it, launcher or File menu.
    projects.record_open(root)
    return await _project_payload()


@router.get("/project/tree")
async def project_tree(
    depth: int = Query(default=_TREE_DEFAULT_DEPTH, ge=1, le=_TREE_MAX_DEPTH),
) -> TreeResponse:
    root = require_root()
    return TreeResponse(root=_build_node(root, root, depth, set()))


@router.get("/files/search")
async def search_files(
    q: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=50, ge=1, le=200),
) -> SearchResponse:
    """Search the workspace for the IDE's search bar.

    The query is matched **literally** (``re.escape``), which is what a search box should do — a
    user typing ``foo(`` is searching for those characters, not raising a regex error. The agent's
    ``search_files`` tool takes a real regular expression, and both share one scan, so the user
    and the model see the same hits under the same ignore rules.
    """
    root = require_root()
    matches, _scanned, truncated = search_workspace(root, re.escape(q), limit=limit)
    return SearchResponse(
        query=q,
        hits=[SearchHit(path=match.path, line=match.line, text=match.text) for match in matches],
        truncated=truncated,
    )


@router.get("/files/content")
async def read_file(path: str = Query(...)) -> FileContent:
    target = workspace.resolve(path)
    if not target.exists() or target.is_dir():
        raise NotFoundError(f"file not found: {path}")
    with target.open("rb") as handle:
        raw = handle.read(_READ_LIMIT + 1)
    truncated = len(raw) > _READ_LIMIT
    return FileContent(
        path=workspace.rel(target),
        content=raw[:_READ_LIMIT].decode("utf-8", errors="replace"),
        language=_language_for(target),
        truncated=truncated,
        bytes=target.stat().st_size,
    )


@router.put("/files/content")
async def write_file(body: WriteFileRequest) -> FileContent:
    target = workspace.resolve(body.path)
    if target.is_dir():
        raise WorkspaceError(f"path is a directory: {body.path}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body.content, encoding="utf-8")
    return FileContent(
        path=workspace.rel(target),
        content=body.content,
        language=_language_for(target),
        bytes=len(body.content.encode("utf-8")),
    )


@router.delete("/files")
async def delete_file(path: str = Query(...)) -> OkResponse:
    root = require_root()
    target = workspace.resolve(path)
    if target == root:
        raise WorkspaceError("refusing to delete the project root")
    if target.is_dir():
        raise WorkspaceError(f"path is a directory: {path}")
    if not target.exists():
        raise NotFoundError(f"file not found: {path}")
    target.unlink()
    return OkResponse()
