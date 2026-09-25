"""Shell execution tools: a raw command runner and a test-runner-aware wrapper."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Annotated

from langchain_core.tools import BaseTool, InjectedToolCallId, tool

from ..config import settings
from ..models import CommandResult
from ..services import runner
from ..services.runner import StreamChunk
from ..services.workspace import require_root, workspace
from .context import ToolContext, run_tool, tool_args

PYTEST_COMMAND = "python -m pytest -q --no-header"
UNITTEST_COMMAND = "python -m unittest discover -s tests -v"
NPM_COMMAND = "npm test --silent"

PYTEST_FAILED = re.compile(r"^(?:FAILED|ERROR)\s+(?P<name>[^\s(]\S*)", re.MULTILINE)
PYTEST_LOCATION = re.compile(r"^(?P<path>[\w./\\-]+\.py):(?P<line>\d+):", re.MULTILINE)
JS_FAILED = re.compile(r"^\s*(?:FAIL|[\u00d7\u2715\u2717])\s+(?P<name>.+?)\s*$", re.MULTILINE)
JS_LOCATION = re.compile(r"\((?P<path>[^()\s]+\.(?:[cm]?[jt]sx?)):(?P<line>\d+):\d+\)")
#: `unittest` writes `FAIL: test_name (module.Class.test_name)` and an absolute File path.
UNITTEST_FAILED = re.compile(r"^(?:FAIL|ERROR):\s+(?P<name>\S+)", re.MULTILINE)
UNITTEST_LOCATION = re.compile(r'File "(?P<path>[^"]+)", line (?P<line>\d+)')
UNITTEST_COUNTS = re.compile(r"(?P<label>failures|errors|skipped)=(?P<count>\d+)")
#: unittest names its counters differently; report one vocabulary whichever runner ran.
UNITTEST_COUNT_LABELS: dict[str, str] = {
    "failures": "failed",
    "errors": "error",
    "skipped": "skipped",
}
COUNTS = re.compile(r"(?P<count>\d+)\s+(?P<label>passed|failed|errors?|skipped)")
MAX_FAILURE_LOCATIONS = 25
OUTPUT_TAIL_CHARS = 1500


def detect_test_runner(root: Path) -> str | None:
    """Return the workspace test command, or ``None`` when nothing is set up."""
    return detect_test_runner_detail(root)[0]


def detect_test_runner_detail(root: Path) -> tuple[str | None, str]:
    """The test command plus why it was chosen.

    The reason matters: a declared pytest setup means pytest is present, whereas a bare
    ``tests/`` directory proves nothing — a ``unittest`` suite in a clean environment would
    otherwise fail the whole phase on a missing dev dependency.
    """
    package_json = root / "package.json"
    if package_json.is_file():
        try:
            manifest = json.loads(package_json.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            manifest = {}
        scripts = manifest.get("scripts")
        if isinstance(scripts, dict):
            test_script = scripts.get("test")
            if isinstance(test_script, str) and test_script.strip():
                return NPM_COMMAND, "package.json declares a test script"
    if (root / "pytest.ini").is_file():
        return PYTEST_COMMAND, "pytest.ini is present"
    pyproject = root / "pyproject.toml"
    if pyproject.is_file():
        try:
            if "[tool.pytest" in pyproject.read_text(encoding="utf-8"):
                return PYTEST_COMMAND, "pyproject.toml configures pytest"
        except OSError:
            return None, "pyproject.toml could not be read"
    if (root / "tests").is_dir():
        # Inference only — the caller must confirm pytest is actually installed.
        return PYTEST_COMMAND, "a tests/ directory exists (pytest assumed)"
    return None, "no package.json test script, pytest config or tests/ directory"


def _unique_matches(pattern: re.Pattern[str], text: str, group: str) -> list[str]:
    found: list[str] = []
    for match in pattern.finditer(text):
        value = match.group(group).strip()
        if value and value not in found:
            found.append(value)
    return found


def _failure_locations(pattern: re.Pattern[str], text: str) -> list[str]:
    found: list[str] = []
    for match in pattern.finditer(text):
        location = f"{match.group('path')}:{match.group('line')}"
        if location not in found:
            found.append(location)
        if len(found) >= MAX_FAILURE_LOCATIONS:
            break
    return found


def _workspace_relative(path: str) -> str:
    """Drop the workspace prefix so pytest's and unittest's paths read alike."""
    root = workspace.root
    if root is not None:
        try:
            return Path(path).relative_to(root).as_posix()
        except ValueError:
            pass
    return path


def summarise_tests(result: CommandResult, command: str) -> str:
    """Render the structured pass/fail summary the QA agent works from."""
    output = f"{result.stdout}\n{result.stderr}"
    ok = result.exit_code == 0 and not result.timed_out and result.error is None
    failed_tests = (
        _unique_matches(PYTEST_FAILED, output, "name")
        or _unique_matches(JS_FAILED, output, "name")
        or _unique_matches(UNITTEST_FAILED, output, "name")
    )
    raw_locations = (
        _failure_locations(PYTEST_LOCATION, output)
        or _failure_locations(JS_LOCATION, output)
        or _failure_locations(UNITTEST_LOCATION, output)
    )
    locations = []
    for location in raw_locations:
        path, _, line = location.rpartition(":")
        locations.append(f"{_workspace_relative(path)}:{line}")

    counts: dict[str, int] = {}
    for match in COUNTS.finditer(output):
        counts[match.group("label").rstrip("s") or "error"] = int(match.group("count"))
    for match in UNITTEST_COUNTS.finditer(output):
        label = UNITTEST_COUNT_LABELS.get(match.group("label"), match.group("label"))
        counts[label] = int(match.group("count"))

    lines = [
        f"{'OK' if ok else 'ERROR'}: {'tests passed' if ok else 'tests failed'} "
        f"(exit={result.exit_code}, {result.duration_ms} ms)",
        f"runner: {command}",
    ]
    if result.timed_out:
        lines.append("timed out before the runner finished")
    if result.error:
        lines.append(f"launch error: {result.error}")
    if counts:
        lines.append(", ".join(f"{label}: {value}" for label, value in counts.items()))
    if failed_tests:
        lines.append(f"failed tests: {', '.join(failed_tests)}")
    if locations:
        lines.append("failures:")
        lines.extend(f"  {location}" for location in locations)
    if not ok and not failed_tests and not locations:
        lines.append("output tail:")
        lines.append(output.strip()[-OUTPUT_TAIL_CHARS:])
    return "\n".join(lines)


def shell_tools(ctx: ToolContext) -> list[BaseTool]:
    """Build the shell tools bound to one agent context."""

    async def stream(tool_call_id: str, chunk: StreamChunk) -> None:
        await ctx.bus.emit_terminal(ctx.session_id, tool_call_id, chunk.channel, chunk.data)

    def render(command: str, workdir: Path, result: CommandResult, timeout: int | None) -> str:
        ok = result.exit_code == 0 and not result.timed_out and result.error is None
        label = workspace.rel(workdir) or "."
        lines = [
            f"{'OK' if ok else 'ERROR'}: {command} "
            f"(exit={result.exit_code}, {result.duration_ms} ms, cwd={label})"
        ]
        if result.timed_out:
            lines.append(f"timed out after {timeout}s and was killed")
        if result.error:
            lines.append(f"launch error: {result.error}")
        if result.stdout.strip():
            lines.append(f"--- stdout ---\n{result.stdout.rstrip()}")
        if result.stderr.strip():
            lines.append(f"--- stderr ---\n{result.stderr.rstrip()}")
        if result.truncated:
            lines.append(f"[output truncated at {settings.max_output_bytes} bytes]")
        return "\n".join(lines)

    async def run_shell(
        tool_call_id: str,
        command: str,
        cwd: str | None,
        timeout: int | None,
    ) -> str:
        workdir = require_root() if cwd is None else workspace.resolve(cwd)
        if ctx.approve is not None and not await ctx.approve(tool_call_id, command, str(workdir)):
            return (
                "ERROR: the user denied this command.\n"
                f"command: {command}\n"
                "Do not retry it. Say briefly what you were trying to find out or change, and ask "
                "the user how they would like to proceed."
            )

        workdir = require_root() if cwd is None else workspace.resolve(cwd)
        if not workdir.is_dir():
            return f"ERROR: {cwd} is not a directory"
        effective_timeout = timeout if timeout and timeout > 0 else settings.command_timeout
        result = await runner.run_command(
            command,
            workdir,
            timeout=effective_timeout,
            max_bytes=settings.max_output_bytes,
            on_chunk=lambda chunk: stream(tool_call_id, chunk),
        )
        return render(command, workdir, result, effective_timeout)

    async def run_test_suite(tool_call_id: str) -> str:
        root = require_root()
        command, reason = detect_test_runner_detail(root)
        notes: list[str] = []

        if ctx.approve is not None:
            # `run_tests` executes project code, so it goes through the same gate as any command.
            probe_ok = await ctx.approve(tool_call_id, command or "the project's test suite", str(root))
            if not probe_ok:
                return (
                    "ERROR: the user denied running the test suite.\n"
                    f"command: {command}\n"
                    "Do not retry it. Report what you wanted to verify and ask how to proceed."
                )

        if command == PYTEST_COMMAND and "assumed" in reason:
            # `tests/` only *suggests* pytest. Confirm it is importable before betting the
            # phase on it: a unittest suite in an environment without pytest would otherwise
            # report a missing dependency instead of running the tests that do exist.
            probe = await runner.run_command(
                'python -c "import pytest"',
                root,
                timeout=60,
                max_bytes=4096,
            )
            if probe.exit_code != 0:
                if (root / "tests").is_dir():
                    notes.append("pytest is not installed; fell back to unittest")
                    command, reason = UNITTEST_COMMAND, "unittest discover (pytest unavailable)"
                else:
                    return (
                        "ERROR: pytest is configured but not installed, and there is no "
                        "tests/ directory to fall back to.\n"
                        f"probe: python -c \"import pytest\" -> exit {probe.exit_code}\n"
                        f"{(probe.stderr or probe.stdout).strip()[:400]}"
                    )

        if command is None:
            return (
                "ERROR: no test runner detected — "
                f"{reason}. Looked for package.json scripts.test, pytest.ini, "
                "pyproject [tool.pytest] and a tests/ directory."
            )

        result = await runner.run_command(
            command,
            root,
            timeout=settings.command_timeout,
            max_bytes=settings.max_output_bytes,
            on_chunk=lambda chunk: stream(tool_call_id, chunk),
        )
        summary = summarise_tests(result, command)
        headline = f"runner: {command} ({reason})"
        if notes:
            headline += f"\nnotes: {'; '.join(notes)}"
        return f"{headline}\n{summary}"

    @tool
    async def run_command(
        command: str,
        cwd: str | None = None,
        timeout: int | None = None,
        tool_call_id: Annotated[str, InjectedToolCallId] = "",
    ) -> str:
        """Run a shell command in the project and stream its output; returns the exit code and captured stdout/stderr."""
        return await run_tool(
            ctx,
            "run_command",
            tool_call_id,
            tool_args(command=command, cwd=cwd, timeout=timeout),
            lambda: run_shell(tool_call_id, command, cwd, timeout),
        )

    @tool
    async def run_tests(tool_call_id: Annotated[str, InjectedToolCallId] = "") -> str:
        """Run the project's test suite (npm test, pytest or unittest) and summarise failures."""
        return await run_tool(
            ctx, "run_tests", tool_call_id, tool_args(), lambda: run_test_suite(tool_call_id)
        )

    return [run_command, run_tests]
