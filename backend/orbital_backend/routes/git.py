"""Git endpoints plus the status reader shared with the project routes."""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
from pathlib import Path

from fastapi import APIRouter

from orbital_backend import config
from orbital_backend.models import (
    CommandResult,
    GitChange,
    GitCommitRequest,
    GitInitRequest,
    GitPushRequest,
    GitStatus,
)
from orbital_backend.services.runner import run_command
from orbital_backend.services.workspace import require_root, workspace

router = APIRouter(prefix="/api/git", tags=["git"])


def _quote(value: str) -> str:
    """Quote one shell argument for the platform shell.

    cmd.exe is happy with ``subprocess.list2cmdline`` quoting: its parser keeps
    ``&``/``|``/``<``/``>`` inside the quoted region, and the escaping of embedded
    quotes is what the MSVC argument parser expects. POSIX shells need ``shlex`` rules.
    """
    if os.name == "nt":
        return subprocess.list2cmdline([value])
    return shlex.quote(value)


async def _git(
    args: str, cwd: Path, *, stdin_data: bytes | None = None
) -> CommandResult:
    return await run_command(
        f"git {args}", cwd, timeout=config.settings.command_timeout, stdin_data=stdin_data
    )


def _parse_branch(text: str) -> tuple[str | None, int, int]:
    ahead = behind = 0
    head = text
    if " [" in text and text.endswith("]"):
        head, _, counts = text.partition(" [")
        for item in counts.rstrip("]").split(","):
            key, _, value = item.strip().partition(" ")
            if key == "ahead":
                ahead = int(value) if value.isdigit() else 0
            elif key == "behind":
                behind = int(value) if value.isdigit() else 0
    branch = head.split("...", 1)[0].strip()
    if branch.startswith("No commits yet on "):
        branch = branch.removeprefix("No commits yet on ").strip()
    return (branch or None), ahead, behind


async def read_git_status(root: Path | None = None) -> GitStatus:
    """Read branch, upstream divergence and the porcelain change list."""
    if shutil.which("git") is None:
        return GitStatus(available=False, repo=False, error="git is not installed on PATH")
    if root is None:
        root = workspace.root
    if root is None:
        return GitStatus(available=True, repo=False, error="no project is open")

    probe = await _git("rev-parse --is-inside-work-tree", root)
    if probe.exit_code != 0 or probe.stdout.strip() != "true":
        return GitStatus(available=True, repo=False, error="not a git repository")

    porcelain = await _git("status --porcelain=v1 --branch", root)
    branch: str | None = None
    ahead = behind = 0
    changed: list[GitChange] = []
    for line in porcelain.stdout.splitlines():
        if line.startswith("## "):
            branch, ahead, behind = _parse_branch(line[3:])
            continue
        if len(line) < 3:
            continue
        status, path = line[:2], line[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        changed.append(
            GitChange(path=path.strip().strip('"'), status=status, staged=status[0] not in " ?")
        )

    remote_result = await _git("remote get-url origin", root)
    remote = remote_result.stdout.strip() if remote_result.exit_code == 0 else ""

    return GitStatus(
        available=True,
        repo=True,
        branch=branch,
        dirty=bool(changed),
        ahead=ahead,
        behind=behind,
        remote=remote or None,
        changed=changed,
    )


@router.get("/status")
async def git_status() -> GitStatus:
    return await read_git_status()


@router.post("/commit")
async def git_commit(body: GitCommitRequest) -> CommandResult:
    root = require_root()
    stage = (
        "add -- " + " ".join(_quote(path) for path in body.paths)
        if body.paths
        else "add -A"
    )
    return await _git(
        f"{stage} && git commit -F -",
        root,
        stdin_data=body.message.encode("utf-8"),
    )


@router.post("/push")
async def git_push(body: GitPushRequest) -> CommandResult:
    root = require_root()
    args = ["push"]
    if body.remote:
        args.append(_quote(body.remote))
    if body.branch:
        args.append(_quote(body.branch))
    return await _git(" ".join(args), root)


@router.post("/init")
async def git_init(body: GitInitRequest) -> CommandResult:
    root = require_root()
    args = "init"
    if body.remote:
        args = f"init && git remote add origin {_quote(body.remote)}"
    return await _git(args, root)
