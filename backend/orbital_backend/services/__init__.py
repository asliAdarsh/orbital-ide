"""Backend services: workspace containment, command execution, sessions, file watching."""

from orbital_backend.services.folder_picker import PickResult, choose_folder, tk_available
from orbital_backend.services.workspace import (
    IGNORED_DIRS,
    REQUIRED_BINARIES,
    Workspace,
    find_missing_binaries,
    require_root,
    workspace,
)
from orbital_backend.services.runner import StreamChunk, run_command
from orbital_backend.services.sessions import SessionStore, sessions
from orbital_backend.services.watcher import SessionWatcher, WatcherRegistry, watchers

__all__ = [
    "IGNORED_DIRS",
    "REQUIRED_BINARIES",
    "PickResult",
    "SessionStore",
    "SessionWatcher",
    "StreamChunk",
    "WatcherRegistry",
    "Workspace",
    "choose_folder",
    "find_missing_binaries",
    "require_root",
    "run_command",
    "sessions",
    "tk_available",
    "watchers",
    "workspace",
]
