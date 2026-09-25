"""The projects the user has created, and where each one lives on disk.

The registry is a single JSON file under :func:`config.projects_file`, written atomically and
read tolerantly: it is a record of what the user built, so a missing or half-written file must
leave them with an empty launcher rather than a backend that will not start.

Every registered directory is also granted as a workspace root (see
:meth:`Workspace.grant_root`), because the packaged desktop build pins ``ORBITAL_ALLOWED_ROOTS``
to its own data directory and a project created anywhere else would otherwise be refused by the
containment check.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from collections.abc import Sequence
from pathlib import Path

from orbital_backend import config
from orbital_backend.errors import CommandError, NotFoundError, ToolError, WorkspaceError, logger
from orbital_backend.models import BRANCH_STRATEGIES, ProjectEntry
from orbital_backend.services.workspace import workspace

_log = logger(__name__)

#: Longest project name and description the dashboards can render without truncating them.
NAME_LIMIT = 80
DESCRIPTION_LIMIT = 280

#: Longest repository URL the registry stores: deep enough for a self-hosted forge's nested
#: groups, short enough that a pasted blob is refused before it reaches the state file.
REPOSITORY_LIMIT = 300

#: The only forms a repository may take. A bare host, a local path or another scheme is not
#: somewhere the sync phase could push to.
_REPOSITORY_PREFIXES = ("https://", "http://", "ssh://", "git@")

#: The branching strategies a project may be built to, by id. The strategies themselves live in
#: ``models`` so the agent instructions and this check are the same list.
_STRATEGY_IDS: tuple[str, ...] = tuple(str(strategy.id) for strategy in BRANCH_STRATEGIES)

#: Characters a name may not contain: a name is a single path segment, never a path.
_NAME_SEPARATORS = ("/", "\\", ":", "..")


def _key(path: str | Path) -> str:
    """Case-folded absolute key, so one directory is one project on a case-insensitive disk."""
    return os.path.normcase(os.path.abspath(path))


def _ordered(entries: Sequence[ProjectEntry]) -> list[ProjectEntry]:
    """Most recently opened first; ties broken by name so the dashboard order is stable."""
    return sorted(entries, key=lambda entry: (-entry.last_opened_at, entry.name))


#: The checkout this backend runs from. A registry entry pointing here is the repository, not a
#: project the user built, so the launcher must never take it out of the list or delete it.
_REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def _is_protected(path: Path) -> bool:
    """True when ``path`` is a location the launcher never manages as a project.

    An entry is only supposed to name a folder this feature created or the user opened, but the
    registry is a plain JSON file: it can be hand-edited, and a client with a bug can register
    anything. A filesystem root, the user's home directory, the state directory and this checkout
    are infrastructure, so removing one is refused whichever ``files`` flag the request carried —
    the guard is about the path, not about the request, and checking it unconditionally keeps the
    safety from depending on a flag a client sends.
    """
    resolved = path.expanduser().resolve()
    if resolved.parent == resolved:
        # A drive or filesystem root is its own parent.
        return True
    if resolved == Path.home().resolve():
        return True
    if resolved == config.state_dir().resolve():
        return True
    return resolved == _REPOSITORY_ROOT


def _validated_name(raw: str) -> str:
    name = str(raw).strip()
    if not name:
        raise WorkspaceError("project name is empty")
    if len(name) > NAME_LIMIT:
        raise WorkspaceError(f"project name is longer than {NAME_LIMIT} characters")
    if any(token in name for token in _NAME_SEPARATORS):
        # The name becomes one directory under ``parent``; a separator would silently write
        # somewhere the user did not choose.
        raise WorkspaceError(f"project name must be a single folder name, not a path: {name}")
    return name


def _validated_parent(raw: str) -> Path:
    text = str(raw).strip()
    if not text:
        raise WorkspaceError("project parent folder is empty")
    try:
        parent = Path(text).expanduser().resolve()
    except OSError as exc:
        raise WorkspaceError(f"cannot resolve parent folder: {raw}") from exc
    if not parent.exists():
        raise WorkspaceError(f"parent folder does not exist: {parent}")
    if not parent.is_dir():
        raise WorkspaceError(f"parent folder is not a directory: {parent}")
    return parent


def _validated_description(raw: str | None) -> str | None:
    description = ("" if raw is None else str(raw)).strip()
    if not description:
        return None
    if len(description) > DESCRIPTION_LIMIT:
        # A bad field in a form, rather than a bad path: the tool-error taxonomy is the closer fit.
        raise ToolError(f"description is longer than {DESCRIPTION_LIMIT} characters")
    return description


def _validated_repository(raw: str | None) -> str | None:
    """A trimmed repository URL, or ``None`` when the field is empty (which clears it)."""
    url = ("" if raw is None else str(raw)).strip()
    if not url:
        return None
    if len(url) > REPOSITORY_LIMIT:
        raise ToolError(f"a repository URL is longer than {REPOSITORY_LIMIT} characters")
    if not url.startswith(_REPOSITORY_PREFIXES):
        raise ToolError("a repository must be an https://, http://, ssh:// or git@ URL")
    return url


def _validated_strategy(raw: str | None) -> str | None:
    """One of the published strategy ids, or ``None`` when the field is empty."""
    strategy = ("" if raw is None else str(raw)).strip()
    if not strategy:
        return None
    if strategy not in _STRATEGY_IDS:
        raise ToolError(
            f"unknown branching strategy {strategy!r}: choose one of {', '.join(_STRATEGY_IDS)}"
        )
    return strategy


def _validated_branching(
    repository: str | None, branch_strategy: str | None
) -> tuple[str | None, str | None]:
    """Validate a repository and a strategy as one setting, returning what to store.

    All-or-nothing: the pair is what the build and sync phases work to, so half of it is a
    configuration the user cannot have meant. Create and update both hand the pair they are about
    to store to this one function, which is what keeps the two from drifting apart.
    """
    url = _validated_repository(repository)
    strategy = _validated_strategy(branch_strategy)
    if url is not None and strategy is None:
        raise ToolError("choose a branching strategy for the repository")
    if url is None and strategy is not None:
        raise ToolError("a branching strategy needs a repository: send a repository URL too")
    return url, strategy


def _read(path: Path) -> list[ProjectEntry]:
    """Read the registry file; anything unreadable is an empty registry, with a warning."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    except OSError as exc:
        _log.warning("could not read the project registry at %s: %s", path, exc)
        return []
    try:
        payload = json.loads(text)
        return [ProjectEntry.model_validate(item) for item in payload["projects"]]
    except (ValueError, KeyError, TypeError) as exc:
        _log.warning("ignoring a corrupt project registry at %s: %s", path, exc)
        return []


def _write(path: Path, entries: Sequence[ProjectEntry]) -> None:
    """Replace the registry file in one step, so a crash cannot leave it half-written."""
    payload = {"projects": [entry.model_dump(mode="json", by_alias=True) for entry in entries]}
    temporary = path.with_name(path.name + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    except OSError as exc:
        raise CommandError(f"could not write the project registry: {exc}") from exc


def _grant_roots(entries: Sequence[ProjectEntry]) -> None:
    """Accept every registered directory as a workspace root for this process.

    Grants are held in memory and widen the containment check's root set; the user's persisted
    ``ORBITAL_ALLOWED_ROOTS`` is never rewritten.
    """
    for entry in entries:
        workspace.grant_root(entry.path)


class ProjectRegistry:
    """Load, list, create, edit and forget projects, writing every change to the registry file."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._path: Path | None = None
        self._entries: list[ProjectEntry] = []

    def ensure_loaded(self) -> None:
        """Read the registry into memory and grant its directories as workspace roots."""
        with self._lock:
            self._current()

    def list(self) -> list[ProjectEntry]:
        """Every registered project, most recently opened first."""
        with self._lock:
            _path, entries = self._current()
            return [entry.model_copy(deep=True) for entry in _ordered(entries)]

    def create(
        self,
        parent: str,
        name: str,
        description: str | None,
        *,
        repository: str | None = None,
        branch_strategy: str | None = None,
    ) -> ProjectEntry:
        """Register ``parent/name``, creating the directory when it is not there yet.

        Asking twice for the same folder is the same project rather than an error: the launcher's
        Create button is one click away from being pressed twice.
        """
        label = _validated_name(name)
        folder = _validated_parent(parent)
        note = _validated_description(description)
        url, strategy = _validated_branching(repository, branch_strategy)
        # Resolved once: the registry compares paths, and the dashboard sends this value back.
        target = (folder / label).resolve()
        if target.is_file():
            raise WorkspaceError(f"a file already exists at {target}")

        with self._lock:
            path, entries = self._current()
            existing = next(
                (entry for entry in entries if _key(entry.path) == _key(target)),
                None,
            )
            if existing is not None:
                # The folder is already a project. A repository named here still belongs to it —
                # otherwise creating a project the launcher already knows silently drops the
                # repository the user just picked.
                stored = (existing.repository, existing.branch_strategy)
                if url is not None and stored != (url, strategy):
                    existing.repository, existing.branch_strategy = url, strategy
                    _write(path, entries)
                return existing.model_copy(deep=True)

            try:
                target.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                # Illegal characters and read-only locations are the user's answer to fix, not a
                # crash: the dashboard shows the reason.
                raise WorkspaceError(f"could not create {target}: {exc}") from exc
            now = int(time.time())
            entry = ProjectEntry(
                id=uuid.uuid4().hex,
                name=label,
                path=str(target),
                description=note,
                created_at=now,
                last_opened_at=now,
                repository=url,
                branch_strategy=strategy,
            )
            entries.append(entry)
            _write(path, entries)
            _grant_roots([entry])
            _log.info("registered project %s at %s", entry.id, entry.path)
            return entry.model_copy(deep=True)

    def update(
        self,
        project_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        favourite: bool | None = None,
        clear_recent: bool | None = None,
        repository: str | None = None,
        branch_strategy: str | None = None,
    ) -> list[ProjectEntry]:
        """Edit a registered project, leaving every ``None`` field as it was.

        An empty ``description`` clears the field (and ``None`` means "not sent"), which is how the
        edit form's blank text box arrives here. The folder itself is never renamed: the name is a
        label the dashboard shows, and moving the user's files because a form field changed would
        be a surprise they did not ask for.

        ``repository`` and ``branch_strategy`` are one setting: the rules apply to the pair the
        project ends up with, so adding a repository to a project that has no strategy needs a
        strategy in the same request, and clearing the repository clears the strategy with it.
        """
        label = _validated_name(name) if name is not None else None
        note = _validated_description(description) if description is not None else None
        with self._lock:
            path, entries = self._current()
            target = next((entry for entry in entries if entry.id == project_id), None)
            if target is None:
                raise NotFoundError(f"unknown project: {project_id}")

            branching: tuple[str | None, str | None] | None = None
            if repository is not None or branch_strategy is not None:
                # The rules apply to the pair the project ends up with, so a field the client did
                # not send falls back to what the project already has.
                wanted_repository = target.repository if repository is None else repository
                wanted_strategy = (
                    target.branch_strategy if branch_strategy is None else branch_strategy
                )
                if repository is not None and not str(repository).strip():
                    # Clearing the repository clears the strategy with it: the pair is one
                    # setting, and a strategy with no repository is one the phases cannot use.
                    wanted_strategy = None
                # Validated before anything is assigned: a refused edit must leave the entry
                # exactly as it was, in memory as well as on disk.
                branching = _validated_branching(wanted_repository, wanted_strategy)

            if label is not None:
                target.name = label
            if description is not None:
                target.description = note
            if favourite is not None:
                target.favourite = favourite
            if clear_recent:
                # Zero rather than "now": the entry sorts to the end of the list and drops out of
                # the launcher's 24-hour recents window, which is what clearing means.
                target.last_opened_at = 0
            if branching is not None:
                target.repository, target.branch_strategy = branching
            _write(path, entries)
            _log.info("updated project %s", project_id)
            return [entry.model_copy(deep=True) for entry in _ordered(entries)]

    def find_by_path(self, path: str | Path) -> ProjectEntry | None:
        """The registered project whose directory is ``path``, or ``None`` when there is none.

        The orchestrator resolves a session's project through this, so the comparison uses the
        same case-folded key the rest of the registry does — a path as the user's shell spelled it
        is the same project as the one the registry stored.
        """
        key = _key(Path(path).expanduser().resolve())
        with self._lock:
            _path, entries = self._current()
            found = next((entry for entry in entries if _key(entry.path) == key), None)
            return None if found is None else found.model_copy(deep=True)

    def forget(self, project_id: str, *, delete_files: bool = False) -> list[ProjectEntry]:
        """Remove a project from the registry and return what remains.

        Without ``delete_files`` nothing on disk is touched: this is the launcher's ordinary
        "remove from recents", and the folder is the user's work.

        With ``delete_files`` the directory goes first and the registry entry only after it is
        gone. That order is deliberate: a deletion that fails part-way leaves the project listed
        with its surviving folder inspectable, where unregistering first would leave a half-deleted
        tree that nothing points at. A failure raises, so the entry stays registered.

        The workspace-root grant survives either way: editor tabs and agent runs may still have the
        folder open, and revoking it mid-session would break reads that already worked.
        """
        with self._lock:
            path, entries = self._current()
            target = next((entry for entry in entries if entry.id == project_id), None)
            if target is None:
                raise NotFoundError(f"unknown project: {project_id}")

            folder = Path(target.path)

            if delete_files:
                # The guard exists to stop a *deletion*, and it is checked only where one could
                # happen: forgetting a list entry destroys nothing, so refusing to forget the
                # checkout or the home directory would only strand an entry the user cannot
                # clear — which is exactly what happens in development, where the checkout
                # itself shows up in recents.
                if _is_protected(folder):
                    raise WorkspaceError(f"refusing to delete {folder}: it is not a project folder")
                if folder.exists():
                    try:
                        shutil.rmtree(folder)
                    except OSError as exc:
                        raise ToolError(f"could not delete {folder}: {exc}") from exc

            remaining = [entry for entry in entries if entry.id != project_id]
            self._entries = remaining
            _write(path, remaining)
            _log.info("forgot project %s (files=%s)", project_id, delete_files)
            return [entry.model_copy(deep=True) for entry in _ordered(remaining)]

    def record_open(self, path: str | Path) -> ProjectEntry:
        """Note that ``path`` was just opened, registering it when it is new.

        Every workspace the user opens ends up in the list, not only the ones created here: a
        folder opened from the title bar's File menu is a project as far as the user is
        concerned, and a launcher that forgets it the moment the app closes is a launcher they
        stop trusting.
        """
        opened = Path(path).expanduser().resolve()
        key = _key(opened)
        with self._lock:
            file_path, entries = self._current()
            for entry in entries:
                if _key(entry.path) == key:
                    entry.last_opened_at = int(time.time())
                    _write(file_path, entries)
                    return entry.model_copy(deep=True)

            now = int(time.time())
            entry = ProjectEntry(
                id=uuid.uuid4().hex,
                name=opened.name or str(opened),
                path=str(opened),
                description=None,
                created_at=now,
                last_opened_at=now,
            )
            entries.append(entry)
            _write(file_path, entries)
            _grant_roots([entry])
            _log.info("recorded opened project %s at %s", entry.id, entry.path)
            return entry.model_copy(deep=True)

    def _current(self) -> tuple[Path, list[ProjectEntry]]:
        """The registry file and its live entry list, reading the file when the path is new.

        Keyed on the resolved path rather than a loaded-once flag so configuring a different
        state directory is honoured instead of serving another file's entries. Caller holds
        the lock.
        """
        path = config.projects_file()
        if path != self._path:
            self._path = path
            self._entries = _read(path)
            _grant_roots(self._entries)
        return path, self._entries


projects = ProjectRegistry()

# Registered directories must be usable as workspace roots before the first request, and the
# grants exist only in this process, so a cold start re-reads the registry here instead of
# waiting for the dashboard to ask for the list.
projects.ensure_loaded()
