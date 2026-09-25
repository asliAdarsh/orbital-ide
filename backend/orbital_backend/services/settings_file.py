"""Writing settings back to ``backend/.env``.

The settings page persists what it changes so a value survives a restart, and it persists it in
the same file the backend already reads — one place to look, and nothing hidden in a database
the user cannot inspect.

The file is rewritten line by line rather than appended to: appending would leave the previous
value above the new one and the file would grow a duplicate of every key on every save.
"""

from __future__ import annotations

from pathlib import Path

from orbital_backend.errors import logger

_log = logger(__name__)

_HEADER = (
    "# Backend configuration, written by the Orbital settings page.\n"
    "# Values here are read at startup and again whenever a run begins.\n"
)


def write_env_values(path: Path, values: dict[str, str]) -> list[str]:
    """Set ``values`` in the dotenv file at ``path``, preserving comments and other keys.

    Returns the keys that were newly written or actually changed. Raises :class:`OSError` if the
    file cannot be written, so the caller can report it rather than silently losing the edit.
    """
    try:
        existing = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        existing = [_HEADER.rstrip("\n")]

    remaining = dict(values)
    lines: list[str] = []
    changed: list[str] = []

    for line in existing:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            lines.append(line)
            continue
        key, _, current = stripped.partition("=")
        key = key.strip()
        if key not in remaining:
            lines.append(line)
            continue
        wanted = remaining.pop(key)
        if current.strip() != wanted:
            changed.append(key)
        lines.append(f"{key}={wanted}")

    for key, wanted in remaining.items():
        lines.append(f"{key}={wanted}")
        changed.append(key)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).rstrip("\n") + "\n", encoding="utf-8")
    _log.info("settings written to %s: %s", path, ", ".join(changed) or "no change")
    return changed
