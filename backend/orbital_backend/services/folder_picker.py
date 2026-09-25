"""Native folder chooser, used when the UI runs in a plain browser.

The desktop build selects folders with the Tauri dialog plugin. In a browser there is no way
to obtain an absolute filesystem path from any web API — ``showDirectoryPicker()``
deliberately returns an opaque handle, and ``<input webkitdirectory>`` only exposes
``C:\\fakepath\\…``. The backend, however, runs on the same machine as the user, so it can
show a real OS dialog and hand back a path the workspace layer can actually use.

Only one dialog may be open at a time and a second request is refused rather than queued:
a modal window nobody is looking at must never wedge every later request behind it.
"""

from __future__ import annotations

import asyncio
import sys
import threading
from dataclasses import dataclass

from orbital_backend.errors import logger

_log = logger(__name__)

#: The frozen sidecar ships without Tk (and the desktop build uses the Tauri dialog instead),
#: so the capability probe short-circuits rather than importing a module that is not there.
_FROZEN = bool(getattr(sys, "frozen", False))

_DIALOG_LOCK = threading.Lock()
_tk_available: bool | None = None

BUSY_REASON = "A folder dialog is already open. Finish or close it first."
UNAVAILABLE_REASON = (
    "This Python installation cannot show a folder dialog. Type the folder path instead."
)


@dataclass(slots=True)
class PickResult:
    """Outcome of one folder-chooser request."""

    path: str | None
    available: bool
    reason: str | None = None


def tk_available() -> bool:
    """Whether this interpreter can show a Tk dialog. Probed once and cached."""
    global _tk_available
    if _tk_available is None:
        if _FROZEN:
            _tk_available = False
        else:
            try:
                import tkinter  # noqa: F401
                from tkinter import filedialog  # noqa: F401
            except Exception as exc:  # noqa: BLE001 - any import failure means "no dialog"
                _log.info("no folder dialog available: %s", exc)
                _tk_available = False
            else:
                _tk_available = True
    return _tk_available


def _ask_directory(title: str | None, initial_dir: str | None) -> str | None:
    """Show the modal directory chooser. Blocking; must run off the event loop."""
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    try:
        # Cosmetic only: raise the dialog above the editor window. A platform that rejects
        # these must still get the dialog.
        for attribute in (lambda: root.attributes("-topmost", True), root.lift, root.focus_force):
            try:
                attribute()
            except tk.TclError:
                pass
        root.update()
        selected = filedialog.askdirectory(
            parent=root,
            title=title or "Open project folder",
            mustexist=True,
            initialdir=initial_dir or None,
        )
    finally:
        root.destroy()
    return selected or None


def _pick_blocking(title: str | None, initial_dir: str | None) -> PickResult:
    """Acquire the dialog slot and show the chooser, releasing the slot when it closes.

    The lock is taken and released inside the worker thread on purpose: if the HTTP request
    is cancelled while the dialog is open, the thread keeps running, so the slot must stay
    held for as long as the window exists — not for as long as the request does.
    """
    if not _DIALOG_LOCK.acquire(blocking=False):
        return PickResult(None, True, BUSY_REASON)
    try:
        _log.info("opening folder dialog")
        selected = _ask_directory(title, initial_dir)
    except Exception as exc:  # noqa: BLE001 - a dialog failure must not fail the request
        _log.warning("folder dialog failed: %s", exc)
        return PickResult(None, False, f"Could not open a folder dialog: {exc}")
    finally:
        _DIALOG_LOCK.release()
    # A cancel is a normal outcome, so it carries no reason for the UI to report.
    return PickResult(selected, True) if selected else PickResult(None, True)


async def choose_folder(title: str | None = None, initial_dir: str | None = None) -> PickResult:
    """Show the OS folder chooser without blocking the event loop."""
    if not tk_available():
        return PickResult(None, False, UNAVAILABLE_REASON)
    return await asyncio.to_thread(_pick_blocking, title, initial_dir)
