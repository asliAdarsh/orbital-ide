"""HTTP contract checks against the real ASGI app.

``ASGITransport`` exercises the routers and error handlers without binding a port and
without running the lifespan (which would print the sidecar ready line).
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from starlette.websockets import WebSocketDisconnect

from orbital_backend.config import settings
from orbital_backend.main import create_app

pytestmark = pytest.mark.asyncio

HEALTH_FIELDS = {
    "status",
    "version",
    "protocolVersion",
    "model",
    "llmConfigured",
    "llmCredential",
    "llmCredentialDetail",
    "missingBinaries",
    "uptimeSeconds",
}

CONFIG_FIELDS = {
    "model",
    "baseUrl",
    "apiKeyConfigured",
    "commandTimeout",
    "maxOutputBytes",
    "allowedRoots",
    "contextWindow",
    "maxTokens",
}


@pytest_asyncio.fixture()
async def client() -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://orbital.test") as http:
        yield http


async def test_health_payload_matches_the_wire_contract(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/health")
    assert response.status_code == 200

    body = response.json()
    assert set(body) == HEALTH_FIELDS
    assert body["status"] == "ok"
    assert body["protocolVersion"] == 1
    assert body["llmCredential"] in {"unknown", "ok", "rejected"}
    assert isinstance(body["missingBinaries"], list)
    assert isinstance(body["uptimeSeconds"], int)


async def test_phases_are_served_in_pipeline_order(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/phases")
    assert response.status_code == 200

    phases = response.json()["phases"]
    assert [phase["id"] for phase in phases] == ["plan", "design", "build", "test", "sync"]
    assert [phase["index"] for phase in phases] == [1, 2, 3, 4, 5]
    for phase in phases:
        assert set(phase) == {"id", "index", "title", "agent", "deliverable", "description"}


async def test_config_never_returns_the_api_key(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/config")
    assert response.status_code == 200

    body = response.json()
    assert set(body) == CONFIG_FIELDS
    # No field may carry key material, whatever the developer's environment holds…
    assert not any("apiKey" in field for field in body if field != "apiKeyConfigured")
    # …and the reported flag must reflect the real setting rather than a hardcoded default.
    assert body["apiKeyConfigured"] is settings.llm_configured
    if settings.llm_api_key:
        assert settings.llm_api_key not in response.text


async def test_pick_folder_returns_the_selected_path(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from orbital_backend.routes import system as system_routes
    from orbital_backend.services.folder_picker import PickResult

    async def fake_choose(title: str | None = None, initial_dir: str | None = None) -> PickResult:
        return PickResult(r"C:\projects\demo", True, None)

    monkeypatch.setattr(system_routes, "choose_folder", fake_choose)

    response = await client.post("/api/system/pick-folder", json={"title": "Open project folder"})

    assert response.status_code == 200
    assert response.json() == {"path": r"C:\projects\demo", "available": True, "reason": None}


async def test_pick_folder_reports_an_unavailable_dialog(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from orbital_backend.routes import system as system_routes
    from orbital_backend.services.folder_picker import PickResult

    async def fake_choose(title: str | None = None, initial_dir: str | None = None) -> PickResult:
        return PickResult(None, False, "This Python installation cannot show a folder dialog.")

    monkeypatch.setattr(system_routes, "choose_folder", fake_choose)

    body = (await client.post("/api/system/pick-folder", json={})).json()

    assert body["path"] is None
    assert body["available"] is False
    assert body["reason"]


async def test_pick_folder_accepts_an_empty_body(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The UI posts no options, so the request body must be optional."""
    from orbital_backend.routes import system as system_routes
    from orbital_backend.services.folder_picker import PickResult

    async def fake_choose(title: str | None = None, initial_dir: str | None = None) -> PickResult:
        return PickResult(None, True, None)

    monkeypatch.setattr(system_routes, "choose_folder", fake_choose)

    response = await client.post("/api/system/pick-folder")

    assert response.status_code == 200
    assert response.json()["path"] is None


async def test_settings_update_persists_and_reports_what_changed(
    client: httpx.AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Saving must rewrite the dotenv file in place, keeping comments and unrelated keys."""
    from orbital_backend.routes import system as system_routes

    env_file = tmp_path / ".env"
    env_file.write_text(
        "# a comment worth keeping\n"
        f"ORBITAL_LLM_API_KEY={settings.llm_api_key}\n"
        "ORBITAL_LLM_MODEL=model-before\n"
        "ORBITAL_UNRELATED=keep-me\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(system_routes, "env_file_path", lambda: env_file)
    monkeypatch.setattr(settings, "llm_model", "model-before")
    monkeypatch.setattr(settings, "context_window", 128000)

    response = await client.put("/api/config", json={"contextWindow": 64000, "model": "model-after"})

    assert response.status_code == 200
    body = response.json()
    assert body["changed"] == ["model", "context_window"]
    assert body["config"]["contextWindow"] == 64000
    assert body["config"]["model"] == "model-after"

    written = env_file.read_text(encoding="utf-8")
    assert "# a comment worth keeping" in written
    assert "ORBITAL_UNRELATED=keep-me" in written
    assert "ORBITAL_LLM_MODEL=model-after" in written
    assert "ORBITAL_CONTEXT_WINDOW=64000" in written
    assert "ORBITAL_LLM_MODEL=model-before" not in written, "the old value must not survive"
    # The running process serves the new values without a restart.
    assert settings.llm_model == "model-after"


async def test_settings_update_with_no_changes_writes_nothing(
    client: httpx.AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from orbital_backend.routes import system as system_routes

    env_file = tmp_path / ".env"
    monkeypatch.setattr(system_routes, "env_file_path", lambda: env_file)

    body = (await client.put("/api/config", json={})).json()

    assert body["changed"] == []
    assert not env_file.exists(), "an empty update must not create or rewrite the file"


async def test_settings_update_clears_the_key_when_asked(
    client: httpx.AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An empty apiKey is the explicit sign-out, and must not be reported as a leak."""
    from orbital_backend.routes import system as system_routes

    env_file = tmp_path / ".env"
    env_file.write_text("ORBITAL_LLM_API_KEY=sk-something\n", encoding="utf-8")
    monkeypatch.setattr(system_routes, "env_file_path", lambda: env_file)
    monkeypatch.setattr(settings, "llm_api_key", "sk-something")

    body = (await client.put("/api/config", json={"apiKey": ""})).json()

    assert body["changed"] == ["api_key"]
    assert body["config"]["apiKeyConfigured"] is False
    assert "sk-something" not in env_file.read_text(encoding="utf-8")
    assert "sk-something" not in json.dumps(body), "the key must never come back"


async def test_search_finds_a_planted_line(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    project = tmp_path / "project"
    (project / "src").mkdir(parents=True)
    (project / "src" / "app.py").write_text("first\nneedle_here()\nthird\n", encoding="utf-8")
    (project / "node_modules").mkdir()
    (project / "node_modules" / "vendored.js").write_text("needle_here()\n", encoding="utf-8")
    assert (await client.post("/api/project/open", json={"path": str(project)})).status_code == 200

    body = (await client.get("/api/files/search", params={"q": "needle_here"})).json()

    assert body["truncated"] is False
    assert [(hit["path"], hit["line"]) for hit in body["hits"]] == [("src/app.py", 2)]
    assert "node_modules" not in json.dumps(body), "ignored directories must not be scanned"


async def test_search_treats_the_query_as_text_not_a_pattern(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    """Typing `foo(` in a search box is a search for those characters, not a regex error."""
    project = tmp_path / "project"
    project.mkdir()
    (project / "a.txt").write_text("call add(1, 2)\n", encoding="utf-8")
    await client.post("/api/project/open", json={"path": str(project)})

    response = await client.get("/api/files/search", params={"q": "add("})

    assert response.status_code == 200
    assert response.json()["hits"][0]["line"] == 1


async def test_unknown_path_returns_json_detail(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/does-not-exist")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["detail"]


async def test_opening_a_missing_project_directory_is_a_400(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    response = await client.post("/api/project/open", json={"path": str(tmp_path / "missing")})
    assert response.status_code == 400
    assert response.json()["detail"]


async def test_project_files_round_trip_and_block_traversal(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / "main.py").write_text("print(1)\n", encoding="utf-8", newline="\n")

    opened = await client.post("/api/project/open", json={"path": str(project)})
    assert opened.status_code == 200
    assert opened.json()["projectPath"] == str(project.resolve())
    assert opened.json()["name"] == "project"
    assert opened.json()["writable"] is True

    tree = await client.get("/api/project/tree", params={"depth": 2})
    assert tree.status_code == 200
    assert tree.json()["root"]["path"] == ""
    assert [node["name"] for node in tree.json()["root"]["children"]] == ["main.py"]

    content = await client.get("/api/files/content", params={"path": "main.py"})
    assert content.status_code == 200
    assert content.json()["content"] == "print(1)\n"
    assert content.json()["language"] == "python"

    escape = await client.get("/api/files/content", params={"path": "../escape.txt"})
    assert escape.status_code == 400
    assert escape.json()["detail"]


async def test_session_state_serialises_phases_as_string_keys(
    client: httpx.AsyncClient,
) -> None:
    response = await client.get("/api/agents/session/test-session")
    assert response.status_code == 200

    body = response.json()
    assert body["sessionId"] == "test-session"
    assert body["activePhase"] == "plan"
    assert body["status"] == "idle"
    assert body["phases"] == {
        "plan": "idle",
        "design": "idle",
        "build": "idle",
        "test": "idle",
        "sync": "idle",
    }


async def test_replacing_the_key_retires_the_verdict_about_the_old_one(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A key the user has just replaced must not be refused by a verdict on the previous one."""
    from orbital_backend.agents import llm as llm_module
    from orbital_backend.routes import system as system_routes

    monkeypatch.setattr(system_routes, "write_env_values", lambda *_args, **_kwargs: ["ORBITAL_LLM_API_KEY"])
    monkeypatch.setattr(llm_module, "_credential_state", "rejected", raising=False)
    monkeypatch.setattr(llm_module, "_credential_detail", "HTTP 401 — Invalid API key.", raising=False)

    original = settings.llm_api_key
    try:
        response = await client.put("/api/config", json={"apiKey": "sk-replaced-not-real"})

        assert response.status_code == 200
        # `changed` reports setting names, which this codebase keeps in their python spelling.
        assert response.json()["changed"] == ["api_key"]
        assert llm_module.credential_status() == ("unknown", None)
    finally:
        # The route assigns onto the live settings object, which monkeypatch cannot intercept.
        settings.llm_api_key = original


# -------------------------------------------------------------------------------------
# Capabilities
# -------------------------------------------------------------------------------------


async def test_capabilities_are_published_in_order_with_both_mode_defaults(
    client: httpx.AsyncClient,
) -> None:
    """The composer renders this list and hardcodes nothing, so the wire carries all of it: the
    order, the wording, and what each mode starts with."""
    response = await client.get("/api/capabilities")

    assert response.status_code == 200
    capabilities = response.json()["capabilities"]
    assert [item["id"] for item in capabilities] == [
        "web",
        "commands",
        "todos",
        "write",
        "tests",
        "git",
    ]
    for item in capabilities:
        assert set(item) == {"id", "label", "description", "planDefault", "buildDefault"}
        assert item["label"] and item["description"]
    # Plan researches and writes the plan; it runs nothing and touches no repository.
    assert [item["id"] for item in capabilities if item["planDefault"]] == ["web", "todos", "write"]
    assert all(item["buildDefault"] for item in capabilities), "Build may do everything"


@pytest.mark.parametrize("transport", ["run", "chat"])
async def test_an_unknown_capability_is_refused_on_both_transports(
    client: httpx.AsyncClient, tmp_path: Path, transport: str
) -> None:
    """Never silently dropped: ignoring an id would run the agent with every tool the caller meant
    to withhold. Both bodies are the socket frames' mirror, so both refuse it the same way."""
    project = tmp_path / "project"
    project.mkdir()
    body: dict[str, object] = {
        "sessionId": f"cap-{transport}",
        "phase": "plan",
        "projectPath": str(project),
        "capabilities": ["web", "teleport"],
        **({"prompt": "plan it"} if transport == "run" else {"message": "hello"}),
    }

    response = await client.post(f"/api/agents/{transport}", json=body)

    assert response.status_code == 400
    assert "teleport" in response.json()["detail"]


class ScriptedSocket:
    """A socket that replays scripted inbound frames and records what came back."""

    def __init__(self, *frames: dict[str, object]) -> None:
        self._inbound = [json.dumps(frame) for frame in frames]
        self.sent: list[dict[str, object]] = []

    async def accept(self) -> None:
        return None

    async def receive_text(self) -> str:
        if not self._inbound:
            raise WebSocketDisconnect()
        return self._inbound.pop(0)

    async def send_json(self, frame: dict[str, object]) -> None:
        self.sent.append(frame)


async def test_the_socket_validates_both_new_fields(
    tmp_path: Path,
) -> None:
    """A capability the backend does not publish and a permission outside the union are both
    refused with a frame the client can read, rather than quietly ignored."""
    from orbital_backend.ws import websocket_endpoint

    project = tmp_path / "project"
    project.mkdir()
    socket = ScriptedSocket(
        {
            "type": "agent.run",
            "sessionId": "ws-capabilities",
            "phase": "build",
            "prompt": "build it",
            "projectPath": str(project),
            "capabilities": ["web", "teleport"],
            "permission": "allow_all",
        },
        {
            "type": "agent.chat",
            "sessionId": "ws-capabilities",
            "phase": "plan",
            "message": "hello",
            "projectPath": str(project),
            "permission": "allow_everything",
        },
    )

    await websocket_endpoint(socket)

    assert [frame["type"] for frame in socket.sent] == ["error", "error"]
    assert "teleport" in socket.sent[0]["payload"]["message"]
    assert socket.sent[1]["payload"]["message"] == "invalid frame"
    assert "permission" in socket.sent[1]["payload"]["detail"]


async def test_each_session_gets_its_own_frame_sequence() -> None:
    """A client can only be sent its own session's frames, so its gap check needs its own counter.

    The process-wide `seq` moves whenever *any* session is busy — a second window, a stale session
    id, another client — and comparing it reported "missed N frames" for frames the client was
    never going to receive. `sessionSeq` is the number that means loss.
    """
    from orbital_backend import models
    from orbital_backend.events import bus

    first = bus.next_session_seq("session-a")
    other = bus.next_session_seq("session-b")
    second = bus.next_session_seq("session-a")

    assert (first, second) == (1, 2), "one session's frames must be contiguous"
    assert other == 1, "another session starts its own count"
    assert bus.next_session_seq(None) is None, "a session-less frame has no session sequence"

    frame = models.event("log", {"level": "info", "message": "hi"}, session_id="session-a", seq=99, session_seq=3)
    assert frame["sessionSeq"] == 3
    assert frame["seq"] == 99
