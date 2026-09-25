"""Shared pytest fixtures.

Also the reason tests work regardless of the directory pytest is launched from:
``backend/`` is put on ``sys.path`` so ``import orbital_backend`` resolves without an
editable install.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


@pytest.fixture
def sample_project(tmp_path: Path) -> Path:
    """A writable workspace with a nested source file and a directory tools must skip."""
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("def main():\n    return 42\n", encoding="utf-8")
    (tmp_path / "README.md").write_text("# sample\n", encoding="utf-8")
    vendored = tmp_path / "node_modules" / "left-pad"
    vendored.mkdir(parents=True)
    (vendored / "index.js").write_text("module.exports = 1\n", encoding="utf-8")
    return tmp_path


@pytest.fixture
def configured_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    """Mark the LLM as configured without making any network call.

    Points ``base_url`` at a closed port so an accidental real request fails loudly
    instead of silently spending the user's budget.
    """
    from orbital_backend.config import settings

    monkeypatch.setattr(settings, "llm_api_key", "sk-test-not-a-real-key")
    monkeypatch.setattr(settings, "llm_base_url", "http://127.0.0.1:9/v1")


@pytest.fixture(autouse=True)
def isolated_state_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Keep every test out of the user's real state directory.

    ``POST /api/project/open`` records the folder it opened, and the registry is a process-wide
    singleton reading ``ORBITAL_STATE_DIR`` — so without this, any test that opens a workspace
    would leave its temporary directories in the real ``projects.json``, where the launcher would
    then offer them to the user. The state directory is keyed on the resolved path, so pointing
    it at a fresh ``tmp_path`` per test also forces a clean reload.
    """
    from orbital_backend.config import settings

    monkeypatch.setattr(settings, "state_dir", tmp_path)
