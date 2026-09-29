"""Skill discovery: the markdown instruction files a composer turns into a prompt.

Two folders are searched, in the order a user would look for them: the workspace's own
``.orbital/skills``, which travels with the project and is shared through the repository, and the
state dir's ``skills``, which belongs to the user and outlives any one project. A skill is text
and nothing else — the backend lists one and reads one, and never writes or executes one, so a
file in either folder is exactly as dangerous as any other markdown the user keeps.

Both the workspace's folder and the user's are the *user's* files, and a stray one must not take
the list down with it: a file that will not decode, will not read, or opens a front-matter block
it never closes is skipped with a warning, and the rest are still listed.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from orbital_backend import config
from orbital_backend.errors import NotFoundError, logger
from orbital_backend.models import Skill, SkillSource
from orbital_backend.services.workspace import workspace

_log = logger(__name__)

#: The workspace's own skills, relative to its root: inside the folder Orbital already owns, so a
#: project's instructions are committed with the project rather than kept beside it.
WORKSPACE_SKILLS = Path(".orbital") / "skills"

#: The user's skills, under the state dir, so they exist for every project.
USER_SKILLS = "skills"

#: The fence that opens and closes an optional front-matter block. Two plain keys live inside it,
#: which is why a hand-written parser is the whole of the YAML support here.
FENCE = "---"


def _unquoted(value: str) -> str:
    """A front-matter value without the quotes a hand-written file may have wrapped it in."""
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1].strip()
    return value


def _pairs(lines: Sequence[str]) -> dict[str, str]:
    """The ``key: value`` pairs in a front-matter block, with no opinion about the others.

    A line with no colon is skipped rather than refused: a comment or a placeholder someone left
    behind is not a reason to hide their skill.
    """
    pairs: dict[str, str] = {}
    for line in lines:
        key, separator, value = line.partition(":")
        if not separator:
            continue
        pairs[key.strip().lower()] = _unquoted(value.strip())
    return pairs


def _split(text: str) -> tuple[dict[str, str], str] | None:
    """The front-matter pairs and the body, or ``None`` for a file that is malformed.

    A file with no opening fence has no front-matter and its whole text is the body. An opening
    fence with no closing one is malformed: the file is not a skill with a long body, it is a file
    whose author started a header and never finished it, and reading the header as the body would
    put ``name:`` in the prompt.
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != FENCE:
        return {}, text.strip()
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == FENCE:
            return _pairs(lines[1:index]), "\n".join(lines[index + 1 :]).strip()
    return None


def _first_line(body: str) -> str:
    """The first line of the body that says anything, which is the description's fallback."""
    for line in body.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def _roots(workspace_path: str | None) -> list[tuple[SkillSource, Path]]:
    """The folders to search, each with the source its skills are reported under.

    The workspace is the path the caller names — a chat carries its own workspace, and the folder
    it points at is not always the one currently open — and falls back to the open project.
    """
    found: list[tuple[SkillSource, Path]] = []
    root = Path(workspace_path).expanduser() if workspace_path else workspace.root
    if root is not None:
        found.append(("workspace", root / WORKSPACE_SKILLS))
    found.append(("user", config.state_dir() / USER_SKILLS))
    return found


def _entry(path: Path, source: SkillSource) -> tuple[Skill, str] | None:
    """One skill and its body, or ``None`` for a file that cannot be read as one.

    Each refusal is said out loud once, here, because this is where the cause is known — the
    caller only learns that the file was skipped.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        _log.warning("skipping unreadable skill file %s: %s", path, exc)
        return None
    split = _split(text)
    if split is None:
        _log.warning("skipping malformed skill file %s: a front-matter block is never closed", path)
        return None
    pairs, body = split
    skill = Skill(
        # The source is part of the id because the two folders may each hold a ``review.md``, and
        # the id is what the composer asks for the body by.
        id=f"{source}:{path.stem}",
        name=pairs.get("name") or path.stem,
        description=pairs.get("description") or _first_line(body),
        source=source,
        path=str(path),
    )
    return skill, body


def _discover(workspace_path: str | None) -> list[tuple[Skill, str]]:
    """Every readable skill, workspace folder first, then the user's, each list sorted by name."""
    discovered: list[tuple[Skill, str]] = []
    for source, directory in _roots(workspace_path):
        try:
            files = sorted(directory.glob("*.md"))
        except OSError as exc:
            # A folder that cannot be listed is reported and the other one is still searched: the
            # user's own skills must not disappear because a project's folder is unreadable.
            _log.warning("could not list the skill folder %s: %s", directory, exc)
            continue
        for path in files:
            entry = _entry(path, source)
            if entry is None:
                # Already named with its cause; the list simply carries on without it.
                continue
            discovered.append(entry)
    return discovered


class SkillLibrary:
    """List and read the skills a chat can use."""

    def list(self, workspace_path: str | None = None) -> list[Skill]:
        """Every skill on this machine, in the order the composer offers them."""
        return [skill.model_copy(deep=True) for skill, _body in _discover(workspace_path)]

    def read(self, skill_id: str, workspace_path: str | None = None) -> tuple[Skill, str]:
        """One skill and its markdown body, or :class:`NotFoundError` naming what was asked for."""
        source, separator, stem = skill_id.partition(":")
        if not separator:
            raise NotFoundError(f"unknown skill: {skill_id}")
        for skill, body in _discover(workspace_path):
            if skill.source == source and Path(skill.path).stem == stem:
                return skill.model_copy(deep=True), body
        raise NotFoundError(f"unknown skill: {skill_id}")


skills = SkillLibrary()
