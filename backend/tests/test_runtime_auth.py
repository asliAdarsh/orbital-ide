"""The gates on the local runtime: the token, the socket, and the credential's one home.

Everything here fails without the hardening. The runtime used to answer any caller that could
reach 127.0.0.1 — which is every page the user has open and every other local account — and it
used to keep a second, world-readable copy of the provider key in ``backend/.env``.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

import httpx
import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from orbital_backend import config, ws
from orbital_backend.agents import llm as llm_module
from orbital_backend.auth import MINTED_TOKEN_WARNING, UNAUTHENTICATED_DETAIL
from orbital_backend.config import settings
from orbital_backend.main import create_app
from orbital_backend.services.providers import providers

#: A key long enough that its tail is a fragment rather than the key, and distinctive enough that
#: finding any part of it in a payload is unambiguous.
SECRET = "sk-live-7c1f4a2e9b0d3f68-secret"

#: The four routes the review found open. ``/api/health`` is in the list on purpose: a gate that
#: spares the health check still tells a scanner that a runtime is there.
OPEN_BEFORE = ("/api/health", "/api/providers", "/api/sessions", "/api/files/content?path=README.md")


def _profile(**overrides: object) -> dict[str, object]:
    body: dict[str, object] = {
        "label": "Zen",
        "kind": "openai-compatible",
        "baseUrl": "https://opencode.ai/zen/v1",
        "model": "deepseek-v4-flash",
        "apiKey": SECRET,
    }
    body.update(overrides)
    return body


def _anonymous_app() -> httpx.AsyncClient:
    """A client against the real app that presents nothing, like a page the user has open."""
    transport = httpx.ASGITransport(app=create_app())
    return httpx.AsyncClient(transport=transport, base_url="http://orbital.test")


# -------------------------------------------------------------------------------------
# The token
# -------------------------------------------------------------------------------------


@pytest.mark.parametrize("path", OPEN_BEFORE)
async def test_a_caller_without_a_token_is_refused_everywhere(path: str) -> None:
    async with _anonymous_app() as http:
        response = await http.get(path)

    assert response.status_code == 401, path
    assert response.json()["detail"] == UNAUTHENTICATED_DETAIL
    # The body has to be enough to act on: the variable to set, and what to run in development.
    assert "ORBITAL_AUTH_TOKEN" in response.json()["detail"]
    assert "npm run backend:dev" in response.json()["detail"]


async def test_a_wrong_token_is_refused_and_the_right_one_is_not(
    client: httpx.AsyncClient, auth_token: str
) -> None:
    async with _anonymous_app() as http:
        wrong = await http.get("/api/health", headers={"Authorization": f"Bearer {auth_token}-x"})
        other_scheme = await http.get("/api/health", headers={"Authorization": auth_token})

    assert wrong.status_code == 401
    assert other_scheme.status_code == 401, "a token outside a bearer scheme is not a token"
    assert (await client.get("/api/health")).status_code == 200


async def test_a_refusal_never_says_whether_a_token_is_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One body for both states: a caller must not learn which one it is facing."""
    async with _anonymous_app() as http:
        configured = await http.get("/api/health")
        monkeypatch.setattr(settings, "auth_token", "")
        unconfigured = await http.get("/api/health")
        minted = await http.get("/api/health", headers={"Authorization": "Bearer guess"})

    assert configured.status_code == unconfigured.status_code == minted.status_code == 401
    assert configured.json() == unconfigured.json() == minted.json()


def test_a_run_with_no_configured_token_refuses_callers_and_says_how_to_fix_it(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """It mints its own secret rather than falling back to open — and says so exactly once.

    The desktop host relies on this path: it has no token of its own and reads the minted one off
    the readiness line. A bare ``python -m orbital_backend`` therefore answers nobody until that
    token is passed on.
    """
    monkeypatch.setattr(settings, "auth_token", "")
    caplog.set_level(logging.WARNING, logger="orbital_backend")

    with TestClient(create_app()) as http:
        response = http.get("/api/health")

    assert response.status_code == 401
    assert response.json()["detail"] == UNAUTHENTICATED_DETAIL
    said = [
        record.getMessage()
        for record in caplog.records
        if record.levelno >= logging.WARNING and record.name.startswith("orbital_backend")
    ]
    assert said == [MINTED_TOKEN_WARNING], "one line, at startup, naming the variable and the fix"
    assert "npm run backend:dev" in MINTED_TOKEN_WARNING


# -------------------------------------------------------------------------------------
# The socket
# -------------------------------------------------------------------------------------


def test_a_socket_that_never_authenticates_is_closed(
    monkeypatch: pytest.MonkeyPatch, auth_token: str
) -> None:
    """A page that opens the socket and says nothing must not hold a connection to a terminal."""
    monkeypatch.setattr(ws, "AUTH_TIMEOUT_SECONDS", 0.1)

    with TestClient(create_app()) as http, pytest.raises(WebSocketDisconnect) as closed:
        with http.websocket_connect("/ws") as socket:
            socket.receive_json()

    assert closed.value.code == 1008


def test_a_socket_with_a_wrong_token_is_closed(auth_token: str) -> None:
    with TestClient(create_app()) as http, pytest.raises(WebSocketDisconnect) as closed:
        with http.websocket_connect("/ws") as socket:
            socket.send_json({"type": "auth", "token": f"{auth_token}-x"})
            socket.receive_json()

    assert closed.value.code == 1008


def test_a_socket_with_the_token_works_and_answers_a_frame(auth_token: str) -> None:
    """The end-to-end case, on a frame that costs nothing: no model call, no workspace.

    ``ping`` rather than ``subscribe`` because the reply to it is the only frame on the wire: a
    subscription also replays whatever artefacts the session has on disk, which is another test's
    subject and would make this one depend on what the process happens to have open.
    """
    with TestClient(create_app()) as http:
        with http.websocket_connect("/ws") as socket:
            socket.send_json({"type": "auth", "token": auth_token})
            socket.send_json({"type": "ping"})
            first = socket.receive_json()
            socket.send_json({"type": "ping"})
            second = socket.receive_json()

    assert first["type"] == "pong"
    assert second["type"] == "pong", "the socket stays usable once the token is in"


def test_a_handshake_from_another_origin_is_refused_and_a_missing_one_is_allowed(
    auth_token: str,
) -> None:
    """A browser does not apply CORS to a WebSocket handshake, so the origin is checked here.

    A missing ``Origin`` is a non-browser local client — the desktop host, a test — and the token
    is what gates it, so it is allowed.
    """
    with TestClient(create_app()) as http:
        with pytest.raises(WebSocketDisconnect) as refused:
            with http.websocket_connect("/ws", headers={"origin": "https://evil.example"}):
                pass
        assert refused.value.code == 1008

        for allowed in ("tauri://localhost", "https://tauri.localhost", "http://localhost:5173"):
            with http.websocket_connect("/ws", headers={"origin": allowed}) as socket:
                socket.send_json({"type": "auth", "token": auth_token})
                socket.send_json({"type": "ping"})
                assert socket.receive_json()["type"] == "pong"


# -------------------------------------------------------------------------------------
# The credential's one home
# -------------------------------------------------------------------------------------


def test_the_dotenv_key_is_blanked_once_the_migration_has_copied_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One home for the key, and it is the file written readable only by this account."""
    env_file = config.env_file_path()
    env_file.write_text(
        "# a comment the migration has no business touching\n"
        f"ORBITAL_LLM_API_KEY={SECRET}\n"
        "ORBITAL_LLM_MODEL=keep-me\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(settings, "llm_api_key", SECRET)
    monkeypatch.setattr(settings, "llm_base_url", "https://opencode.ai/zen/go/v1")
    monkeypatch.setattr(settings, "llm_model", "deepseek-v4-flash")

    imported = providers.migrate_from_env()

    assert imported is not None and imported.api_key == SECRET
    written = env_file.read_text(encoding="utf-8")
    assert SECRET not in written, "the credential must not survive in a second file"
    assert "ORBITAL_LLM_API_KEY=\n" in written
    assert "ORBITAL_LLM_MODEL=keep-me" in written, "everything that is not the key is left alone"
    assert settings.llm_api_key == "", "the running process does not keep a copy either"


async def test_the_settings_endpoint_refuses_an_api_key_rather_than_saving_one(
    client: httpx.AsyncClient,
) -> None:
    """A client that still sends one is told, instead of believing it wrote a credential."""
    env_file = config.env_file_path()
    env_file.write_text("ORBITAL_LLM_MODEL=before\n", encoding="utf-8")

    response = await client.put("/api/config", json={"apiKey": SECRET})

    assert response.status_code == 400
    assert "apiKey" in response.json()["detail"]
    assert SECRET not in env_file.read_text(encoding="utf-8")
    assert settings.llm_api_key != SECRET


@pytest.mark.parametrize(
    "address",
    [
        "http://127.0.0.1:11434/v1",
        "http://localhost:11434/v1",
        "http://169.254.169.254/latest/meta-data",
        "http://10.0.0.5/v1",
        "http://[::1]:8080/v1",
    ],
)
async def test_a_cloud_profile_refuses_an_address_on_this_machine(
    client: httpx.AsyncClient, address: str
) -> None:
    """A key is a credential for a provider, not for whatever answers on a local address."""
    refused = await client.post("/api/providers", json=_profile(baseUrl=address))

    assert refused.status_code == 400, address
    assert "local" in refused.json()["detail"]

    accepted = await client.post("/api/providers", json=_profile(kind="local", baseUrl=address))

    assert accepted.status_code == 200, "the local kind exists for exactly this endpoint"
    assert accepted.json()["profiles"][0]["baseUrl"] == address


async def test_repointing_a_profile_that_holds_a_key_says_where_the_key_will_go(
    client: httpx.AsyncClient,
) -> None:
    profile = (await client.post("/api/providers", json=_profile())).json()["profiles"][0]

    moved = await client.patch(
        f"/api/providers/{profile['id']}", json={"baseUrl": "https://elsewhere.example/v1"}
    )
    body = moved.json()

    assert moved.status_code == 200
    assert body["profiles"][0]["baseUrl"] == "https://elsewhere.example/v1"
    assert body["profiles"][0]["apiKeySet"] is True, "the key is kept, not silently dropped"
    assert body["notice"] is not None
    assert "opencode.ai" in body["notice"] and "elsewhere.example" in body["notice"]

    renamed = await client.patch(f"/api/providers/{profile['id']}", json={"label": "Zen 2"})

    assert renamed.json()["notice"] is None, "an edit that moves no credential says nothing"


def _probe_transport(
    monkeypatch: pytest.MonkeyPatch, handler: Callable[[httpx.Request], httpx.Response]
) -> None:
    """Answer the model probe without a socket — the same seam ``test_providers`` uses."""
    real = httpx.AsyncClient
    monkeypatch.setattr(
        llm_module.httpx,
        "AsyncClient",
        lambda **kwargs: real(transport=httpx.MockTransport(handler), **kwargs),
    )


async def test_a_provider_that_echoes_the_key_back_does_not_get_it_stored_or_logged(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Providers quote the key they refused. That text travels to the UI, ``/api/health`` and the
    log, so the credential — and the tail they tend to quote — is stripped before any of them."""
    profile = (await client.post("/api/providers", json=_profile())).json()["profiles"][0]
    _probe_transport(
        monkeypatch,
        lambda _request: httpx.Response(
            401,
            json={
                "error": {
                    "message": (
                        f"Incorrect API key provided: {SECRET}. "
                        f"You can find your API key at …/{SECRET[-8:]}"
                    )
                }
            },
        ),
    )
    caplog.set_level(logging.DEBUG, logger="orbital_backend")

    tested = await client.post(f"/api/providers/{profile['id']}/test")
    health = await client.get("/api/health")
    logged = "\n".join(record.getMessage() for record in caplog.records)

    assert tested.status_code == 200
    for text in (tested.text, health.text, logged):
        assert SECRET not in text
        assert SECRET[-8:] not in text
    assert "Incorrect API key" in tested.json()["detail"], "the reason itself is still reported"
    assert "Incorrect API key" in health.json()["llmCredentialDetail"]
