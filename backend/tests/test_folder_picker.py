"""Tests for the native folder chooser.

The dialog itself is stubbed: showing a real one would block a test run on a human click.
Everything around it is exercised for real — the return contract, the degradation path when
Tk is missing or the dialog raises, and the refusal to stack a second modal window.
"""

from __future__ import annotations

import pytest

from orbital_backend.services import folder_picker as picker


async def test_returns_the_selected_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(picker, "tk_available", lambda: True)
    monkeypatch.setattr(picker, "_ask_directory", lambda title, initial: r"C:\projects\demo")

    result = await picker.choose_folder("Open project folder")

    assert result.path == r"C:\projects\demo"
    assert result.available is True
    assert result.reason is None


async def test_cancelling_is_not_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(picker, "tk_available", lambda: True)
    monkeypatch.setattr(picker, "_ask_directory", lambda title, initial: "")

    result = await picker.choose_folder()

    assert result.path is None
    assert result.available is True
    assert result.reason is None, "a cancel must not surface as a problem to the user"


async def test_a_second_dialog_is_refused_rather_than_queued(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(picker, "tk_available", lambda: True)
    assert picker._DIALOG_LOCK.acquire(blocking=False)
    try:
        result = await picker.choose_folder()
    finally:
        picker._DIALOG_LOCK.release()

    assert result.path is None
    assert result.available is True
    assert result.reason and "already open" in result.reason


async def test_a_failing_dialog_degrades_instead_of_raising(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(picker, "tk_available", lambda: True)

    def explode(title: str | None, initial: str | None) -> str | None:
        raise RuntimeError("no display name and no $DISPLAY environment variable")

    monkeypatch.setattr(picker, "_ask_directory", explode)

    result = await picker.choose_folder()

    assert result.path is None
    assert result.available is False
    assert result.reason and "no display" in result.reason
    assert not picker._DIALOG_LOCK.locked(), "the dialog slot must be released after a failure"


async def test_a_runtime_without_tk_reports_itself_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(picker, "tk_available", lambda: False)

    result = await picker.choose_folder()

    assert result.path is None
    assert result.available is False
    assert result.reason


def test_tk_availability_is_probed_without_raising() -> None:
    """The probe must answer on any interpreter, including one without Tk."""
    assert isinstance(picker.tk_available(), bool)
