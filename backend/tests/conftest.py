"""Shared pytest fixtures.

Also the reason tests work regardless of the directory pytest is launched from:
``backend/`` is put on ``sys.path`` so ``import orbital_backend`` resolves without an
editable install.
"""

from __future__ import annotations

import sys
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from orbital_backend.main import create_app  # noqa: E402 - needs the path above


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


@pytest.fixture(autouse=True)
def isolated_env_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Keep every test out of the real ``backend/.env``.

    Two code paths write that file: the migration that blanks the key it has just imported, and
    ``PUT /api/config``. Both resolve it through ``config.env_file_path()``, so redirecting the
    module's path is enough to keep a test from rewriting the file the developer's own key is in.
    """
    from orbital_backend import config

    monkeypatch.setattr(config, "_ENV_FILE", tmp_path / ".env")


#: The token the shared client authenticates with. Every test runs against a runtime that has one,
#: because that is the normal state of the app; the tests that are *about* the gate set their own.
TEST_AUTH_TOKEN = "test-runtime-token"


@pytest.fixture(autouse=True)
def auth_token(monkeypatch: pytest.MonkeyPatch) -> str:
    """Give the application a token to accept, and hand it to the test that asked by name."""
    from orbital_backend.config import settings

    monkeypatch.setattr(settings, "auth_token", TEST_AUTH_TOKEN)
    return TEST_AUTH_TOKEN


@pytest_asyncio.fixture()
async def client() -> AsyncIterator[httpx.AsyncClient]:
    """The real ASGI app, authenticated the way the host authenticates to it."""
    transport = httpx.ASGITransport(app=create_app())
    headers = {"Authorization": f"Bearer {TEST_AUTH_TOKEN}"}
    async with httpx.AsyncClient(
        transport=transport, base_url="http://orbital.test", headers=headers
    ) as http:
        yield http


@pytest.fixture(scope="session", autouse=True)
def runtime_port_is_left_free() -> Iterator[None]:
    """The suite must not leave a backend holding the port the app talks to.

    Nothing here spawns a runtime — the tests drive the ASGI application in process, and none of
    them binds a socket — but a leaked ``python -m orbital_backend`` would squat on the port a
    developer's next run and the packaged app both need, and it would answer with a token nobody
    knows. This is the check that catches that the day a test does spawn one: it only applies when
    the port was free to begin with, so a machine already running its own runtime is untouched.
    """
    import socket

    from orbital_backend.config import settings

    def bindable() -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", settings.port))
            except OSError:
                return False
        return True

    if not bindable():
        yield
        return
    yield
    assert bindable(), (
        f"something is still listening on 127.0.0.1:{settings.port} after the suite: a test "
        "leaked a runtime process"
    )
