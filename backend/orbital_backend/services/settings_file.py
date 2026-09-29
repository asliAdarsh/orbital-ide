"""Writing settings back to ``backend/.env``.

The settings page persists what it changes so a value survives a restart, and it persists it in
the same file the backend already reads — one place to look, and nothing hidden in a database
the user cannot inspect.

The file is rewritten line by line rather than appended to: appending would leave the previous
value above the new one and the file would grow a duplicate of every key on every save. It is
also rewritten through a temporary file that is closed to other accounts before it is moved into
place — until the first start moves it into the provider store, this file holds the fallback
``ORBITAL_LLM_API_KEY``, and on a POSIX box a default file would be readable by every account on
the machine.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from orbital_backend.errors import CommandError, logger

_log = logger(__name__)

_HEADER = (
    "# Backend configuration, written by the Orbital settings page.\n"
    "# Values here are read at startup and again whenever a run begins.\n"
)


def restrict_to_user(path: Path) -> None:
    """Make ``path`` readable and writable by the account that owns it and nobody else.

    Mode 0600 on POSIX, and on Windows the inherited access control list is replaced by one entry
    for the current account (``icacls`` wants it as ``DOMAIN\\user``, hence the domain when the
    environment carries one).

    Raises :class:`CommandError` rather than logging a warning. Both callers write a file that
    holds a credential, and "the key is saved but every local account can read it" is a failure
    the user has to see and decide about — a log line nothing reads is not that.
    """
    try:
        if sys.platform == "win32":
            account = os.environ.get("USERNAME", "").strip()
            domain = os.environ.get("USERDOMAIN", "").strip()
            if not account:
                raise CommandError(
                    f"could not restrict {path} to the current user: no USERNAME in the environment"
                )
            grant = f"{domain}\\{account}" if domain else account
            subprocess.run(
                ["icacls", str(path), "/inheritance:r", "/grant:r", f"{grant}:(F)"],
                check=True,
                capture_output=True,
                text=True,
            )
        else:
            os.chmod(path, 0o600)
    except (OSError, subprocess.SubprocessError) as exc:
        raise CommandError(f"could not restrict {path} to the current user: {exc}") from exc


def write_env_values(path: Path, values: dict[str, str]) -> list[str]:
    """Set ``values`` in the dotenv file at ``path``, preserving comments and other keys.

    Returns the keys that were newly written or actually changed. Raises :class:`OSError` if the
    file cannot be written, and :class:`CommandError` if it cannot be closed to other accounts, so
    the caller can report either rather than silently losing the edit or saving a readable secret.
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
    # Restricted before the move, because ``os.replace`` keeps the permissions the file already
    # has: tightening the final path afterwards would leave a window in which it is world-readable.
    temporary = path.with_name(path.name + ".tmp")
    try:
        temporary.write_text("\n".join(lines).rstrip("\n") + "\n", encoding="utf-8")
        restrict_to_user(temporary)
    except (OSError, CommandError):
        temporary.unlink(missing_ok=True)
        raise
    os.replace(temporary, path)
    _log.info("settings written to %s: %s", path, ", ".join(changed) or "no change")
    return changed
