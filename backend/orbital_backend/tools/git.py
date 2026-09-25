"""Git tools for the repository-sync phase.

Every tool degrades to an ``ERROR:`` string instead of raising: agents must be able to
recover from a missing git binary, a non-repo workspace, or a rejected push on their own.
"""

from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
from typing import Annotated

from langchain_core.tools import BaseTool, InjectedToolCallId, tool

from ..config import settings
from ..models import CommandResult, GitChange, GitStatus
from ..services import runner
from ..services.workspace import require_root, workspace
from .context import ToolContext, run_tool, tool_args

REMOTE_NAME = "origin"
#: What a branch may be called. Git's own rules are looser, but the agent only ever picks
#: names from a branch model, and refusing oddities here keeps a typo from becoming a ref.
_BRANCH_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$")
_GIT_MISSING = "ERROR: git is not installed or not on PATH"
_AHEAD_BEHIND = re.compile(r"(ahead|behind) (\d+)")


def quote_arg(value: str) -> str:
    """Quote one git argument for the shell the runner uses (commit messages contain spaces)."""
    return subprocess.list2cmdline([value]) if os.name == "nt" else shlex.quote(value)


def parse_status(porcelain: str) -> GitStatus:
    """Parse ``git status --porcelain --branch`` into the wire model."""
    branch: str | None = None
    remote: str | None = None
    ahead = 0
    behind = 0
    changed: list[GitChange] = []
    for line in porcelain.splitlines():
        if line.startswith("## "):
            header = line[3:].strip()
            if header.startswith("No commits yet on "):
                branch = header[len("No commits yet on ") :]
                continue
            name, _, upstream = header.partition("...")
            branch = name.strip() or None
            if upstream:
                tracking = upstream.split(" [", 1)[0].strip()
                if "/" in tracking:
                    remote = tracking.split("/", 1)[0]
                for direction, distance in _AHEAD_BEHIND.findall(upstream):
                    if direction == "ahead":
                        ahead = int(distance)
                    else:
                        behind = int(distance)
            continue
        code = line[:2]
        path = line[3:].strip()
        if not path:
            continue
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        changed.append(
            GitChange(path=path, status=code.strip() or "??", staged=code[0] not in (" ", "?"))
        )
    return GitStatus(
        available=True,
        repo=True,
        branch=branch,
        dirty=bool(changed),
        ahead=ahead,
        behind=behind,
        remote=remote,
        changed=changed,
    )


def git_tools(ctx: ToolContext) -> list[BaseTool]:
    """Build the git tools bound to one agent context."""

    async def git(*args: str) -> CommandResult:
        command = " ".join(["git", *(quote_arg(arg) for arg in args)])
        return await runner.run_command(
            command,
            require_root(),
            timeout=settings.command_timeout,
            max_bytes=settings.max_output_bytes,
        )

    def failure(action: str, result: CommandResult) -> str:
        detail = (result.stderr or result.stdout).strip() or (result.error or "unknown git error")
        return f"ERROR: {action} failed (exit={result.exit_code})\n{detail}"

    async def status_impl() -> str:
        if shutil.which("git") is None:
            missing = GitStatus(available=False, repo=False, error="git binary not found")
            return f"{_GIT_MISSING}\n{missing.model_dump_json(by_alias=True)}"
        result = await git("status", "--porcelain", "--branch")
        if result.exit_code != 0 or result.error:
            detail = (result.stderr or result.stdout).strip() or result.error
            offline = GitStatus(available=True, repo=False, error=detail)
            return f"ERROR: not a git repository\n{offline.model_dump_json(by_alias=True)}"
        return f"OK: git status\n{parse_status(result.stdout).model_dump_json(by_alias=True)}"

    async def init_impl(remote: str | None) -> str:
        if shutil.which("git") is None:
            return _GIT_MISSING
        result = await git("init")
        if result.exit_code != 0 or result.error:
            return failure("git init", result)
        lines = [f"OK: initialised repository at {require_root()}"]
        if remote:
            added = await git("remote", "add", REMOTE_NAME, remote)
            if added.exit_code != 0:
                updated = await git("remote", "set-url", REMOTE_NAME, remote)
                if updated.exit_code != 0:
                    return failure(f"configuring remote {remote}", updated)
            lines.append(f"remote {REMOTE_NAME} -> {remote}")
        return "\n".join(lines)

    async def commit_impl(message: str, paths: list[str] | None) -> str:
        if not message.strip():
            return "ERROR: git_commit requires a non-empty commit message"
        if shutil.which("git") is None:
            return _GIT_MISSING
        inside = await git("rev-parse", "--is-inside-work-tree")
        if inside.exit_code != 0:
            return "ERROR: the workspace is not a git repository; run git_init first"
        targets = [workspace.rel(workspace.resolve(path)) for path in paths] if paths else []
        staged = await git("add", "--", *targets) if targets else await git("add", "-A")
        if staged.exit_code != 0 or staged.error:
            return failure("git add", staged)
        committed = await git("commit", "-m", message, *(["--", *targets] if targets else []))
        if committed.exit_code != 0 or committed.error:
            combined = f"{committed.stdout}\n{committed.stderr}"
            if "nothing to commit" in combined or "no changes added" in combined:
                return "OK: nothing to commit, the working tree is clean"
            return failure("git commit", committed)
        head = await git("rev-parse", "--short", "HEAD")
        sha = head.stdout.strip() if head.exit_code == 0 else "unknown"
        return f"OK: committed {sha} - {message.splitlines()[0]}"

    async def branch_impl(name: str, create: bool, start_point: str | None) -> str:
        """Switch to a branch, creating it from `start_point` when asked."""
        if shutil.which("git") is None:
            return _GIT_MISSING
        target = name.strip()
        if not _BRANCH_NAME.match(target) or ".." in target or target.endswith("/"):
            return (
                f"ERROR: {name!r} is not a usable branch name. Use letters, digits, `.`, `_`, `-` "
                "and `/` — a name like `feat/checkout-total`."
            )
        inside = await git("rev-parse", "--is-inside-work-tree")
        if inside.exit_code != 0:
            return "ERROR: the workspace is not a git repository; run git_init first"
        if not create:
            switched = await git("checkout", target)
            return (
                f"OK: on branch {target}"
                if switched.exit_code == 0
                else failure(f"checkout {target}", switched)
            )
        base = start_point.strip() if start_point else None
        created = (
            await git("checkout", "-b", target, base)
            if base
            else await git("checkout", "-b", target)
        )
        if created.exit_code != 0 or created.error:
            return failure(f"creating branch {target}", created)
        return f"OK: created and switched to {target}" + (f" from {base}" if base else "")

    async def push_impl(remote: str | None, branch: str | None) -> str:
        if shutil.which("git") is None:
            return _GIT_MISSING
        args = ["push"]
        if remote and branch:
            args += ["--set-upstream", remote, branch]
        elif remote:
            args += [remote]
        elif branch:
            args += ["--set-upstream", REMOTE_NAME, branch]
        result = await git(*args)
        if result.exit_code != 0 or result.error:
            return failure("git push", result)
        detail = (result.stderr or result.stdout).strip()
        head = f"OK: git {' '.join(args)} completed"
        return f"{head}\n{detail}" if detail else head

    @tool
    async def git_status(tool_call_id: Annotated[str, InjectedToolCallId] = "") -> str:
        """Report branch, remote, ahead/behind and changed files for the project repository."""
        return await run_tool(ctx, "git_status", tool_call_id, tool_args(), status_impl)

    @tool
    async def git_init(
        remote: str | None = None, tool_call_id: Annotated[str, InjectedToolCallId] = ""
    ) -> str:
        """Initialise a git repository in the project root and optionally set the origin remote."""
        return await run_tool(
            ctx, "git_init", tool_call_id, tool_args(remote=remote), lambda: init_impl(remote)
        )

    @tool
    async def git_commit(
        message: str,
        paths: list[str] | None = None,
        tool_call_id: Annotated[str, InjectedToolCallId] = "",
    ) -> str:
        """Stage and commit the project (or just the given paths) with a non-empty message."""
        return await run_tool(
            ctx,
            "git_commit",
            tool_call_id,
            tool_args(message=message, paths=paths),
            lambda: commit_impl(message, paths),
        )

    @tool
    async def git_branch(
        name: str,
        create: bool = False,
        start_point: str | None = None,
        tool_call_id: Annotated[str, InjectedToolCallId] = "",
    ) -> str:
        """Switch to a branch, or create it (`create=True`) from `start_point`. Follows the
        project's branching model: never force, never rewrite, never rename a shared branch."""
        return await run_tool(
            ctx,
            "git_branch",
            tool_call_id,
            tool_args(name=name, create=create, start_point=start_point),
            lambda: branch_impl(name, create, start_point),
        )

    @tool
    async def git_push(
        remote: str | None = None,
        branch: str | None = None,
        tool_call_id: Annotated[str, InjectedToolCallId] = "",
    ) -> str:
        """Push the current branch, or the given branch to the given remote, reporting remote errors verbatim."""
        return await run_tool(
            ctx,
            "git_push",
            tool_call_id,
            tool_args(remote=remote, branch=branch),
            lambda: push_impl(remote, branch),
        )

    return [git_status, git_init, git_branch, git_commit, git_push]
