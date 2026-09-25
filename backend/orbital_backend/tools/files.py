"""Workspace file tools exposed to Orbital agents.

All paths are workspace-relative and go through ``Workspace.resolve``, which blocks
``..``/absolute/symlink escapes, so the tools can never touch anything outside the
opened project.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Annotated

from langchain_core.tools import BaseTool, InjectedToolCallId, tool

from ..models import ARTIFACT_NAMES, artifact_relative_path
from ..services.search import MAX_SEARCH_HITS, search_workspace
from ..services.sessions import sessions
from ..services.workspace import IGNORED_DIRS, require_root, workspace
from .context import ToolContext, run_tool, tool_args

READ_LIMIT_BYTES = 200 * 1024
MAX_DIRECTORY_ENTRIES = 500
MIN_DEPTH = 1
MAX_DEPTH = 6


def file_tools(ctx: ToolContext) -> list[BaseTool]:
    """Build the file tools bound to one agent context."""

    async def read_text(path: str) -> str:
        target = workspace.resolve(path)
        if target.is_dir():
            return f"ERROR: {path} is a directory"
        if not target.is_file():
            return f"ERROR: {path} does not exist"
        size = target.stat().st_size
        with target.open("rb") as handle:
            raw = handle.read(READ_LIMIT_BYTES)
        clipped = f", clipped to {READ_LIMIT_BYTES}" if size > READ_LIMIT_BYTES else ""
        return (
            f"OK: {workspace.rel(target)} ({size} bytes{clipped})\n"
            f"{raw.decode('utf-8', errors='replace')}"
        )

    async def write_text(path: str, content: str) -> str:
        target = workspace.resolve(path)
        if target.is_dir():
            return f"ERROR: {path} is a directory"
        target.parent.mkdir(parents=True, exist_ok=True)
        data = content.encode("utf-8")
        target.write_bytes(data)
        return f"OK: wrote {workspace.rel(target)} ({len(data)} bytes)"

    async def delete_path(path: str) -> str:
        target = workspace.resolve(path)
        if target == require_root():
            return "ERROR: refusing to delete the project root"
        if target.is_dir():
            return f"ERROR: {path} is a directory; delete_file removes files only"
        if not target.is_file():
            return f"ERROR: {path} does not exist"
        target.unlink()
        return f"OK: deleted {workspace.rel(target)}"

    async def list_tree(path: str, depth: int) -> str:
        target = workspace.resolve(path)
        if not target.is_dir():
            return f"ERROR: {path} is not a directory"
        level = max(MIN_DEPTH, min(MAX_DEPTH, depth))
        lines: list[str] = []
        count = 0
        suppressed = 0

        def walk(directory: Path, remaining: int, indent: str) -> None:
            nonlocal count, suppressed
            if remaining <= 0:
                return
            for entry in sorted(
                directory.iterdir(), key=lambda item: (item.is_file(), item.name.lower())
            ):
                if entry.name in IGNORED_DIRS or entry.is_symlink():
                    continue
                if count >= MAX_DIRECTORY_ENTRIES:
                    suppressed += 1
                    continue
                count += 1
                if entry.is_dir():
                    lines.append(f"{indent}{entry.name}/")
                    walk(entry, remaining - 1, indent + "  ")
                else:
                    lines.append(f"{indent}{entry.name} ({entry.stat().st_size} b)")

        walk(target, level, "")
        if suppressed:
            lines.append(f"...[{suppressed} more entries suppressed]")
        root_label = workspace.rel(target) or "."
        return "\n".join([f"OK: {root_label} ({count} entries, depth {level})", *lines])

    async def search_tree(pattern: str, path: str) -> str:
        target = workspace.resolve(path)
        if not target.is_dir():
            return f"ERROR: {path} is not a directory"
        try:
            matches, scanned, truncated = search_workspace(target, pattern)
        except re.error as exc:
            return f"ERROR: invalid regular expression {pattern!r}: {exc}"
        header = f"OK: {len(matches)} hit(s) for {pattern!r} in {scanned} file(s)"
        if truncated:
            header += f", capped at {MAX_SEARCH_HITS}"
        lines = [f"{match.path}:{match.line}: {match.text}" for match in matches]
        return "\n".join([header, *lines])

    async def write_artifact_file(name: str, content: str) -> str:
        relative = artifact_relative_path(name)
        if relative is None:
            return f"ERROR: unknown artifact {name!r}; expected one of {', '.join(ARTIFACT_NAMES)}"
        target = require_root() / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        data = content.encode("utf-8")
        target.write_bytes(data)
        # The frame updates the UI that is watching; the session copy is what a UI that reloads
        # reads, so an artefact written during a conversation survives one — which is the whole
        # point of the agent writing the plan while you talk instead of at the end of a run.
        sessions.set_artifact(ctx.session_id, relative, content)
        # The UI keys artefacts by their relative path, so agent/plan.md is what it sees.
        await ctx.emit(
            "artifact.updated", {"name": relative, "content": content}, session_id=ctx.session_id
        )
        return f"OK: wrote artifact {relative} ({len(data)} bytes)"

    async def read_artifact_text(name: str) -> str:
        relative = artifact_relative_path(name)
        if relative is None:
            return f"ERROR: unknown artifact {name!r}; expected one of {', '.join(ARTIFACT_NAMES)}"
        if not (require_root() / relative).is_file():
            return f"ERROR: artifact {relative} has not been produced yet"
        return await read_text(relative)

    @tool
    async def read_file(
        path: str, tool_call_id: Annotated[str, InjectedToolCallId] = ""
    ) -> str:
        """Read a UTF-8 text file from the project, clipped at 200 KB. Path is project-relative."""
        return await run_tool(
            ctx, "read_file", tool_call_id, tool_args(path=path), lambda: read_text(path)
        )

    @tool
    async def write_file(
        path: str,
        content: str,
        tool_call_id: Annotated[str, InjectedToolCallId] = "",
    ) -> str:
        """Create or overwrite a text file, making parent directories as needed. Returns the byte count."""
        return await run_tool(
            ctx,
            "write_file",
            tool_call_id,
            tool_args(path=path, content=content),
            lambda: write_text(path, content),
        )

    @tool
    async def delete_file(
        path: str, tool_call_id: Annotated[str, InjectedToolCallId] = ""
    ) -> str:
        """Delete one file from the project. Refuses to delete the project root or a directory."""
        return await run_tool(
            ctx, "delete_file", tool_call_id, tool_args(path=path), lambda: delete_path(path)
        )

    @tool
    async def list_directory(
        path: str = ".",
        depth: int = 2,
        tool_call_id: Annotated[str, InjectedToolCallId] = "",
    ) -> str:
        """List a project directory tree (depth 1-6). Skips node_modules, .git, dist, build, .venv, __pycache__, target, .next, coverage."""
        return await run_tool(
            ctx,
            "list_directory",
            tool_call_id,
            tool_args(path=path, depth=depth),
            lambda: list_tree(path, depth),
        )

    @tool
    async def search_files(
        pattern: str,
        path: str = ".",
        tool_call_id: Annotated[str, InjectedToolCallId] = "",
    ) -> str:
        """Search project text files with a Python regular expression; returns up to 200 path:line matches."""
        return await run_tool(
            ctx,
            "search_files",
            tool_call_id,
            tool_args(pattern=pattern, path=path),
            lambda: search_tree(pattern, path),
        )

    @tool
    async def read_artifact(
        name: str, tool_call_id: Annotated[str, InjectedToolCallId] = ""
    ) -> str:
        """Read a pipeline artifact: agent/plan.md, agent/test-report.md, or agent/Agents.md."""
        return await run_tool(
            ctx, "read_artifact", tool_call_id, tool_args(name=name), lambda: read_artifact_text(name)
        )

    @tool
    async def write_artifact(
        name: str,
        content: str,
        tool_call_id: Annotated[str, InjectedToolCallId] = "",
    ) -> str:
        """Write a pipeline artifact (plan.md, test-report.md, Agents.md) and publish it to the UI."""
        return await run_tool(
            ctx,
            "write_artifact",
            tool_call_id,
            tool_args(name=name, content=content),
            lambda: write_artifact_file(name, content),
        )

    return [
        read_file,
        write_file,
        delete_file,
        list_directory,
        search_files,
        read_artifact,
        write_artifact,
    ]
