"""Test-runner detection and failure parsing.

The detection used to treat any ``tests/`` directory as proof of pytest, so a ``unittest``
suite in an environment without pytest reported a missing dependency instead of running the
tests that existed. These cover the inference, the fallback and the parsing of both runners.
"""

from __future__ import annotations

import json
from pathlib import Path

from orbital_backend.models import CommandResult
from orbital_backend.services.workspace import workspace
from orbital_backend.tools.shell import (
    NPM_COMMAND,
    PYTEST_COMMAND,
    UNITTEST_COMMAND,
    detect_test_runner,
    detect_test_runner_detail,
    summarise_tests,
)


def test_a_declared_npm_test_wins(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(json.dumps({"scripts": {"test": "vitest run"}}), encoding="utf-8")
    assert detect_test_runner(tmp_path) == NPM_COMMAND


def test_a_pytest_config_is_a_declaration(tmp_path: Path) -> None:
    (tmp_path / "pytest.ini").write_text("[pytest]\n", encoding="utf-8")
    command, reason = detect_test_runner_detail(tmp_path)
    assert command == PYTEST_COMMAND
    assert "declar" in reason or "present" in reason
    assert "assumed" not in reason


def test_a_bare_tests_directory_is_only_an_inference(tmp_path: Path) -> None:
    """This is the case that needs a probe: a tests/ directory proves nothing about pytest."""
    (tmp_path / "tests").mkdir()
    command, reason = detect_test_runner_detail(tmp_path)
    assert command == PYTEST_COMMAND
    assert "assumed" in reason


def test_nothing_set_up_reports_none(tmp_path: Path) -> None:
    command, reason = detect_test_runner_detail(tmp_path)
    assert command is None
    assert reason


def test_unittest_output_is_parsed(tmp_path: Path) -> None:
    """unittest's FAIL lines, counts and absolute File paths must all be read."""
    workspace.set_root(tmp_path)
    # unittest reports absolute paths; the summary must make them workspace-relative.
    failing_file = tmp_path / "tests" / "test_app.py"
    output = (
        "test_bad (tests.test_app.T.test_bad) ... "
        "FAIL\n"
        "======================================================================\n"
        "FAIL: test_bad (tests.test_app.T.test_bad)\n"
        "----------------------------------------------------------------------\n"
        f'  File "{failing_file}", line 10, in test_bad\n'
        "    self.assertEqual(add(2, 2), 5)\n"
        "AssertionError: 4 != 5\n"
        "\n"
        "----------------------------------------------------------------------\n"
        "Ran 2 tests in 0.001s\n"
        "\n"
        "FAILED (failures=1)\n"
    )
    result = CommandResult(
        command=UNITTEST_COMMAND, cwd=str(tmp_path), exit_code=1, stdout=output, duration_ms=40
    )

    summary = summarise_tests(result, UNITTEST_COMMAND)

    assert "failed tests: test_bad" in summary
    assert "tests/test_app.py:10" in summary, summary
    assert "failed: 1" in summary, summary
    assert "(failures=1)" not in summary, "the summary line must not be read as a test name"


def test_pytest_output_is_parsed(tmp_path: Path) -> None:
    workspace.set_root(tmp_path)
    output = (
        "=========================== short test summary info ===========================\n"
        "FAILED tests/test_app.py::T::test_bad - AssertionError: 4 != 5\n"
        "========================= 2 failed, 5 passed in 0.21s =========================\n"
    )
    result = CommandResult(
        command=PYTEST_COMMAND, cwd=str(tmp_path), exit_code=1, stdout=output, duration_ms=210
    )

    summary = summarise_tests(result, PYTEST_COMMAND)

    assert "failed tests: tests/test_app.py::T::test_bad" in summary
    assert "failed: 2" in summary and "passed: 5" in summary
