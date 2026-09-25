"""Turn the composer's attachments into context for one model call.

An attachment is a workspace-relative path the user picked in the composer. Two paths consume
them, and they cannot carry the same things:

* a **chat turn** sends a multimodal ``HumanMessage``, so an attached image is inlined as an
  ``image_url`` data-URL part and a vision-capable model can actually look at it;
* a **run** hands the supervisor a brief that is a plain string, so an attached image reaches
  the specialist as its name and size and never as pixels.

That asymmetry is expressed here, once: :func:`build_chat_context` and
:func:`build_run_context` differ only in what an image becomes, while the shared
:func:`_describe` is the single place a path is read, capped and reported.

Every cap lives in the constants below, so a turn that attaches a whole repository costs what a
turn that attaches nothing costs instead of quietly filling the model's context window.
"""

from __future__ import annotations

import base64
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .workspace import workspace

#: At most this many paths are read; the rest are named as ignored.
MAX_ATTACHMENTS = 12

#: How much of one text file is inlined, and how much text is inlined across all of them.
MAX_TEXT_FILE_BYTES = 128 * 1024
TOTAL_TEXT_BUDGET_BYTES = 256 * 1024

#: An image above this is named and refused rather than attached.
MAX_IMAGE_BYTES = 4 * 1024 * 1024

#: Immediate entries listed for an attached directory.
MAX_DIRECTORY_ENTRIES = 50

#: Suffixes whose contents are inlined in a fenced block.
TEXT_SUFFIXES: frozenset[str] = frozenset(
    {
        ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".md", ".txt", ".css", ".html",
        ".yml", ".yaml", ".toml", ".cfg", ".ini", ".sh", ".ps1", ".sql", ".rs", ".go",
        ".java", ".rb", ".php", ".cs", ".c", ".h", ".cpp",
    }
)

#: Suffixes that become an ``image_url`` part on the chat path.
IMAGE_SUFFIXES: frozenset[str] = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp"})

_MEDIA_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

_HEADER = (
    "## Attached context\n"
    "The user attached these workspace items to this turn. Paths are relative to the workspace "
    "root."
)


@dataclass(slots=True, frozen=True)
class AttachmentContext:
    """What a list of attachments contributes to one chat message.

    ``text`` is empty when nothing was attached, which is how the caller knows to send a plain
    string message rather than a list of content parts.
    """

    text: str = ""
    images: tuple[dict[str, Any], ...] = ()


def build_chat_context(paths: Sequence[str] | None) -> AttachmentContext:
    """The context for a chat turn: one text block plus an ``image_url`` part per image.

    Raises:
        WorkspaceError: when a path is not inside the workspace — absolute, ``..`` or a symlink
            that leaves the root. The message names the offending path.
    """
    text, images = _build(paths, embed_images=True)
    return AttachmentContext(text=text, images=tuple(images))


def build_run_context(paths: Sequence[str] | None) -> str:
    """The context for a run: the text block appended to the phase brief.

    Text only, and deliberately so. The supervisor's brief is a string, so an attached image
    cannot be shown to the specialist on this path: the block names the file and its size and
    says the model cannot see it, which is honest about the limit instead of implying an image
    was delivered. A run that needs the picture has to be a chat turn.
    """
    return _build(paths, embed_images=False)[0]


def _build(paths: Sequence[str] | None, *, embed_images: bool) -> tuple[str, list[dict[str, Any]]]:
    """Render every attachment, returning the text block and the image parts."""
    wanted = [path for path in (paths or []) if path.strip()]
    if not wanted:
        return "", []

    sections: list[str] = []
    images: list[dict[str, Any]] = []
    budget = TOTAL_TEXT_BUDGET_BYTES
    for path in wanted[:MAX_ATTACHMENTS]:
        # Resolution is what refuses an escape; the message names the path that did it.
        target = workspace.resolve(path)
        # An attached project root has no relative name, so it is labelled the way a path is.
        relative = workspace.rel(target) or "."
        section, image, consumed = _describe(
            relative, target, budget=budget, embed_images=embed_images
        )
        sections.append(section)
        if image is not None:
            images.append(image)
        budget = max(0, budget - consumed)

    ignored = len(wanted) - MAX_ATTACHMENTS
    if ignored > 0:
        sections.append(
            f"_{ignored} further attachment(s) were ignored: {MAX_ATTACHMENTS} is the limit._"
        )
    return "\n\n".join([_HEADER, *sections]), images


def _describe(
    relative: str,
    target: Path,
    *,
    budget: int,
    embed_images: bool,
) -> tuple[str, dict[str, Any] | None, int]:
    """One attachment as a markdown section, an image part when there is one, and its cost."""
    if target.is_dir():
        return _directory(relative, target), None, 0
    if not target.is_file():
        return f"### `{relative}`\n_does not exist_", None, 0
    try:
        size = target.stat().st_size
    except OSError as exc:
        return f"### `{relative}`\n_unreadable: {exc}_", None, 0

    suffix = target.suffix.lower()
    if suffix in IMAGE_SUFFIXES:
        section, image = _image(relative, target, size, embed_images=embed_images)
        return section, image, 0
    if suffix in TEXT_SUFFIXES:
        section, consumed = _text_file(relative, target, size, budget)
        return section, None, consumed
    return (
        f"### `{relative}` ({size} bytes)\n"
        "file — not a text file or an image, so it was not read.",
        None,
        0,
    )


def _directory(relative: str, target: Path) -> str:
    """A directory's immediate entries, each marked as a file or a directory."""
    try:
        entries = sorted(target.iterdir(), key=lambda entry: (entry.is_file(), entry.name.lower()))
    except OSError as exc:
        return f"### `{relative}`\n_unreadable: {exc}_"

    shown = entries[:MAX_DIRECTORY_ENTRIES]
    listing = ", ".join(
        f"`{entry.name}` ({'directory' if entry.is_dir() else 'file'})" for entry in shown
    )
    if len(entries) > len(shown):
        listing = f"{listing}, … {len(entries) - len(shown)} more"
    count = len(entries)
    noun = "entry" if count == 1 else "entries"
    return f"### `{relative}` — directory, {count} {noun}\n{listing or '_empty_'}"


def _text_file(relative: str, target: Path, size: int, budget: int) -> tuple[str, int]:
    """A text file's contents in a fenced block, capped per file and in total."""
    if budget <= 0:
        return (
            f"### `{relative}` ({size} bytes)\n"
            "text file — the inline context budget is already used up; read it with `read_file`.",
            0,
        )

    limit = min(MAX_TEXT_FILE_BYTES, budget)
    try:
        with target.open("rb") as handle:
            raw = handle.read(limit + 1)
    except OSError as exc:
        return f"### `{relative}` ({size} bytes)\n_unreadable: {exc}_", 0

    truncated = len(raw) > limit
    body = raw[:limit].decode("utf-8", errors="replace")
    fence = target.suffix.lower().lstrip(".")
    lines = [f"### `{relative}` ({size} bytes)", f"```{fence}", body.rstrip("\n"), "```"]
    if truncated:
        reason = "per-file limit" if limit == MAX_TEXT_FILE_BYTES else "remaining inline budget"
        lines.append(f"... [truncated: showing the first {limit} of {size} bytes — {reason}]")
    return "\n".join(lines), len(body)


def _image(
    relative: str, target: Path, size: int, *, embed_images: bool
) -> tuple[str, dict[str, Any] | None]:
    """An image as an ``image_url`` part, or as a line saying why it is not one."""
    header = f"### `{relative}` ({size} bytes)"
    if size > MAX_IMAGE_BYTES:
        return (
            f"{header}\nimage — too large to attach: the limit is {MAX_IMAGE_BYTES} bytes.",
            None,
        )
    if not embed_images:
        return (
            f"{header}\nimage — named only: this path sends text, so the model cannot see it.",
            None,
        )
    try:
        data = target.read_bytes()
    except OSError as exc:
        return f"{header}\n_unreadable: {exc}_", None
    media_type = _MEDIA_TYPES[target.suffix.lower()]
    encoded = base64.b64encode(data).decode("ascii")
    return (
        f"{header}\nimage — attached to this message.",
        {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{encoded}"}},
    )
