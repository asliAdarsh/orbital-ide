"""Project root bookkeeping: path containment, tree metadata and binary discovery."""

from __future__ import annotations

import os
import re
import shutil
import threading
from collections.abc import Sequence
from pathlib import Path

from orbital_backend import config
from orbital_backend.errors import WorkspaceError

REQUIRED_BINARIES: tuple[str, ...] = ("git", "node", "npm", "python", "pytest")

#: Directory names the tree walker and the file watcher never descend into.
IGNORED_DIRS: frozenset[str] = frozenset(
    {
        "node_modules",
        ".git",
        "dist",
        "build",
        ".venv",
        "__pycache__",
        "target",
        ".next",
        "coverage",
    }
)

_SEPARATORS = re.compile(r"[\\/]+")


def _key(path: Path) -> str:
    """Case-folded absolute key, so containment holds on case-insensitive filesystems."""
    return os.path.normcase(os.path.abspath(path))


def _is_within(path: Path, root: Path) -> bool:
    path_key = _key(path)
    root_key = _key(root)
    return path_key == root_key or path_key.startswith(root_key + os.sep)


class Workspace:
    """The single project root the backend is currently serving."""

    def __init__(self, allowed_roots: Sequence[str] | None = None) -> None:
        self._root: Path | None = None
        self.allowed_roots: list[str] = list(
            config.settings.allowed_roots if allowed_roots is None else allowed_roots
        )
        #: Roots accepted for this process only, keyed by :func:`_key` so a directory is listed
        #: once. Registered projects live here: they must be usable as workspace roots without
        #: rewriting ``ORBITAL_ALLOWED_ROOTS``, which the desktop build owns.
        self._granted_roots: dict[str, Path] = {}
        self._granted_lock = threading.Lock()

    @property
    def root(self) -> Path | None:
        return self._root

    def grant_root(self, path: str | Path) -> None:
        """Accept ``path`` as an allowed root in this process, without touching the setting.

        It only ever widens the root set: the traversal, absolute-path and symlink rules in
        :meth:`resolve` are unchanged, and a path outside a non-empty ``allowed_roots`` is
        still refused unless it is one of these grants.
        """
        granted = Path(path).expanduser().resolve()
        with self._granted_lock:
            self._granted_roots[_key(granted)] = granted

    def set_root(self, path: str | Path) -> Path:
        """Open ``path`` as the project root; it must be an existing directory."""
        text = str(path).strip()
        if not text:
            raise WorkspaceError("project path is empty")
        try:
            resolved = Path(text).expanduser().resolve()
        except OSError as exc:
            raise WorkspaceError(f"cannot resolve project path: {path}") from exc
        if not resolved.exists():
            raise WorkspaceError(f"project path does not exist: {resolved}")
        if not resolved.is_dir():
            raise WorkspaceError(f"project path is not a directory: {resolved}")
        self._root = resolved
        return resolved

    def resolve(self, rel: str) -> Path:
        """Map a workspace-relative path onto disk, refusing every escape hatch.

        Rejects absolute paths (drive or root component), any ``..`` component, symlinks
        whose target leaves the root, and — when ``allowed_roots`` is non-empty — any
        target outside one of those roots.
        """
        root = self._require_root()
        text = str(rel)
        if text in ("", ".", "./", ".\\"):
            candidate = root
        else:
            raw = Path(text)
            if raw.drive or raw.root:
                raise WorkspaceError(f"absolute paths are not allowed: {rel}")
            parts = [part for part in _SEPARATORS.split(text) if part and part != "."]
            if ".." in parts:
                raise WorkspaceError(f"path traversal is not allowed: {rel}")
            candidate = root.joinpath(*parts)

        resolved = candidate.resolve()
        if not _is_within(resolved, root):
            raise WorkspaceError(f"path escapes the project root: {rel}")
        allowed = self._allowed_root_paths()
        if allowed and not any(_is_within(resolved, entry) for entry in allowed):
            raise WorkspaceError(f"path is outside the allowed roots: {rel}")
        return resolved

    def resolve_dir(self, value: str | None) -> Path:
        """Resolve a command working directory: root-relative or absolute, but contained."""
        root = self._require_root()
        if not value:
            return root
        candidate = Path(value)
        if candidate.drive or candidate.root:
            resolved = candidate.expanduser().resolve()
            if not _is_within(resolved, root):
                raise WorkspaceError(f"working directory escapes the project root: {value}")
        else:
            resolved = self.resolve(value)
        if not resolved.is_dir():
            raise WorkspaceError(f"working directory does not exist: {value}")
        return resolved

    def rel(self, path: str | Path) -> str:
        """Return ``path`` relative to the root with POSIX separators (``""`` for the root)."""
        root = self._require_root()
        resolved = Path(path).expanduser().resolve()
        if not _is_within(resolved, root):
            raise WorkspaceError(f"path is outside the project root: {path}")
        relative = os.path.relpath(resolved, root)
        return "" if relative == os.curdir else Path(relative).as_posix()

    def is_writable(self) -> bool:
        root = self._root
        return root is not None and root.is_dir() and os.access(root, os.W_OK)

    def exists(self) -> bool:
        root = self._root
        return root is not None and root.is_dir()

    def name(self) -> str:
        return "" if self._root is None else self._root.name

    def _allowed_root_paths(self) -> list[Path]:
        """Resolved roots a contained path must fall inside; empty means unrestricted.

        Grants are added only when the persisted setting already restricts: an empty
        ``allowed_roots`` keeps meaning "whatever the open project contains", so registering a
        project can never narrow what the containment check accepts.
        """
        allowed = [Path(entry).expanduser().resolve() for entry in self.allowed_roots]
        if not allowed:
            return []
        with self._granted_lock:
            allowed.extend(self._granted_roots.values())
        return allowed

    def _require_root(self) -> Path:
        if self._root is None:
            raise WorkspaceError("no project is open")
        return self._root


workspace = Workspace()


def require_root() -> Path:
    """Return the open project root or raise :class:`WorkspaceError`."""
    root = workspace.root
    if root is None:
        raise WorkspaceError("no project is open")
    return root


def find_missing_binaries() -> list[str]:
    """Names in :data:`REQUIRED_BINARIES` that are not resolvable on ``PATH``."""
    return [name for name in REQUIRED_BINARIES if shutil.which(name) is None]
