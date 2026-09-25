"""Workspace text search.

Shared by the agent's ``search_files`` tool and the IDE's search bar, so a hit the model sees
and a hit the user sees come from the same scan under the same ignore rules — and there is only
one place to change how the workspace is walked.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from orbital_backend.services.workspace import IGNORED_DIRS

#: Ceiling on returned matches. Callers report that it was reached rather than truncating
#: silently, because "no more matches" and "we stopped looking" are different answers.
MAX_SEARCH_HITS = 200

#: Files larger than this are skipped: almost always generated or vendored.
MAX_SEARCH_FILE_BYTES = 1024 * 1024

#: Characters of a matching line kept in the result.
MAX_MATCH_CHARS = 400


@dataclass(frozen=True, slots=True)
class SearchMatch:
    """One matching line, with a path relative to the searched root."""

    path: str
    line: int
    text: str


def search_workspace(
    root: Path, pattern: str, *, limit: int = MAX_SEARCH_HITS
) -> tuple[list[SearchMatch], int, bool]:
    """Scan ``root`` for the regular expression ``pattern``.

    Returns the matches, how many files were actually read, and whether ``limit`` was reached.
    Raises :class:`re.error` for an invalid pattern so the caller can report it in its own
    vocabulary (``ERROR:`` for a tool, a 400 for the API).
    """
    regex = re.compile(pattern)
    matches: list[SearchMatch] = []
    scanned = 0

    for directory, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            name
            for name in dirnames
            if name not in IGNORED_DIRS and not (Path(directory) / name).is_symlink()
        )
        for filename in sorted(filenames):
            if len(matches) >= limit:
                return matches, scanned, True
            file_path = Path(directory) / filename
            if file_path.is_symlink():
                continue
            try:
                if file_path.stat().st_size > MAX_SEARCH_FILE_BYTES:
                    continue
                text = file_path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            scanned += 1
            relative = file_path.relative_to(root).as_posix()
            for lineno, line in enumerate(text.splitlines(), start=1):
                if not regex.search(line):
                    continue
                matches.append(
                    SearchMatch(path=relative, line=lineno, text=line.strip()[:MAX_MATCH_CHARS])
                )
                if len(matches) >= limit:
                    return matches, scanned, True

    return matches, scanned, False
