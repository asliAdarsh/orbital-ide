"""Provider profiles: what the API stores, what it returns, and what a run then talks to.

The HTTP calls go through the real ASGI app, as everywhere else. The one thing that is never
real is the provider: the model probe is answered by an ``httpx`` mock transport, so a refused
key, a dead endpoint and a healthy one are all exercised without a socket.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from collections.abc import Callable
from typing import Any, AsyncIterator

import httpx
import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from orbital_backend.agents import graph as graph_module
from orbital_backend.agents import llm as llm_module
from orbital_backend.agents import runner as runner_module
from orbital_backend.agents.llm import build_llm
from orbital_backend.config import settings
from orbital_backend.errors import LLMNotConfigured
from orbital_backend.models import Phase, RunStatus
from orbital_backend.services.providers import provider_file, providers
from orbital_backend.services.sessions import sessions

pytestmark = pytest.mark.asyncio

#: Exactly the fields a profile may have on the wire: a field named ``apiKey`` is not among them,
#: and the two that mention a key can only carry a boolean and a four-character tail.
PROFILE_FIELDS = {
    "id",
    "label",
    "kind",
    "baseUrl",
    "model",
    "models",
    "modelsFetchedAt",
    "modelsSource",
    "apiKeySet",
    "apiKeyHint",
    "active",
    "createdAt",
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

#: A key worth asserting about: long enough that its tail is a hint rather than the key, and
#: distinctive enough that finding it anywhere in a response is unambiguous.
SECRET = "sk-live-9f3c2b7a5d1e4c8b-nope"


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


async def _created(client: httpx.AsyncClient, **overrides: object) -> dict[str, object]:
    """Create a profile through the API and return it as the wire carried it back."""
    response = await client.post("/api/providers", json=_profile(**overrides))
    assert response.status_code == 200, response.text
    return response.json()["profiles"][-1]


def _probe_transport(
    monkeypatch: pytest.MonkeyPatch, handler: Callable[[httpx.Request], httpx.Response]
) -> list[httpx.Request]:
    """Answer the model probe without a socket, and record what it asked.

    The probe builds its own client, so the only seam that needs no test-shaped code in the
    backend is the client class itself; ``monkeypatch`` puts it back afterwards.
    """
    asked: list[httpx.Request] = []

    def recording(request: httpx.Request) -> httpx.Response:
        asked.append(request)
        return handler(request)

    real = httpx.AsyncClient
    monkeypatch.setattr(
        llm_module.httpx,
        "AsyncClient",
        lambda **kwargs: real(transport=httpx.MockTransport(recording), **kwargs),
    )
    return asked


def _answers(status: int, payload: object) -> Callable[[httpx.Request], httpx.Response]:
    """One answer per request: connect asks twice, and a response is read once."""
    return lambda _request: httpx.Response(status, json=payload)


def _record_llm(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, object]]:
    """Capture what ``build_llm`` would hand the client, instead of building one."""
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(llm_module, "ChatOpenAI", lambda **kwargs: calls.append(kwargs) or object())
    return calls


# -------------------------------------------------------------------------------------
# The list, and what moving the active badge means
# -------------------------------------------------------------------------------------


async def test_the_first_profile_created_is_the_one_that_starts_active(
    client: httpx.AsyncClient,
) -> None:
    """An empty settings page that leaves the profile a user just made inactive looks broken."""
    first = await _created(client)
    await _created(client, label="Local", kind="local", baseUrl="http://127.0.0.1:11434/v1")

    body = (await client.get("/api/providers")).json()

    assert [item["label"] for item in body["profiles"]] == ["Zen", "Local"]
    assert body["activeId"] == first["id"]
    assert [item["active"] for item in body["profiles"]] == [True, False]
    assert set(body["profiles"][0]) == PROFILE_FIELDS


async def test_activating_moves_the_badge_and_deleting_the_active_moves_it_again(
    client: httpx.AsyncClient,
) -> None:
    first = await _created(client)
    second = await _created(client, label="Local", kind="local", baseUrl="http://127.0.0.1:11434/v1")

    body = (await client.post(f"/api/providers/{second['id']}/activate")).json()
    assert body["activeId"] == second["id"]
    assert [item["active"] for item in body["profiles"]] == [False, True]

    body = (await client.delete(f"/api/providers/{second['id']}")).json()
    assert [item["label"] for item in body["profiles"]] == ["Zen"]
    assert body["activeId"] == first["id"], "the badge must not be left pointing at nothing"
    assert body["profiles"][0]["active"] is True

    body = (await client.delete(f"/api/providers/{first['id']}")).json()
    assert body["profiles"] == []
    assert body["activeId"] is None


async def test_patching_leaves_the_fields_it_does_not_carry_alone(
    client: httpx.AsyncClient,
) -> None:
    profile = await _created(client)

    body = (
        await client.patch(
            f"/api/providers/{profile['id']}", json={"model": "deepseek-v4-pro", "apiKey": ""}
        )
    ).json()

    updated = body["profiles"][0]
    assert updated["model"] == "deepseek-v4-pro"
    assert updated["label"] == "Zen"
    assert updated["baseUrl"] == "https://opencode.ai/zen/v1"
    assert updated["apiKeySet"] is False, "an empty key is the explicit way to clear one"
    assert updated["apiKeyHint"] is None


# -------------------------------------------------------------------------------------
# The key
# -------------------------------------------------------------------------------------


async def test_no_response_body_ever_carries_the_key(client: httpx.AsyncClient) -> None:
    """Asserted on the raw text: this payload is rendered in a desktop window and logged by proxies."""
    profile = await _created(client)

    responses = [
        await client.get("/api/providers"),
        await client.patch(f"/api/providers/{profile['id']}", json={"label": "Zen 2"}),
        await client.post(f"/api/providers/{profile['id']}/activate"),
    ]

    for response in responses:
        assert SECRET not in response.text
        for item in response.json().get("profiles") or []:
            assert "apiKey" not in item
            assert set(item) == PROFILE_FIELDS

    shown = responses[0].json()["profiles"][0]
    assert shown["apiKeySet"] is True
    assert shown["apiKeyHint"] == SECRET[-4:]
    # The absence above is the point: the key really is in the store, it just never travels back.
    assert SECRET in provider_file().read_text(encoding="utf-8")


async def test_a_run_uses_the_active_profile_rather_than_the_dotenv_values(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _created(client)
    monkeypatch.setattr(settings, "llm_api_key", "sk-from-dotenv")
    monkeypatch.setattr(settings, "llm_base_url", "https://dotenv.example/v1")
    monkeypatch.setattr(settings, "llm_model", "dotenv-model")

    calls = _record_llm(monkeypatch)
    build_llm()

    assert calls[0]["api_key"] == SECRET
    assert calls[0]["base_url"] == "https://opencode.ai/zen/v1"
    assert calls[0]["model"] == "deepseek-v4-flash"


async def test_the_dotenv_endpoint_is_used_when_no_profile_exists(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A fresh clone has no profiles at all, and must behave exactly as it did before them."""
    monkeypatch.setattr(settings, "llm_api_key", "sk-from-dotenv")
    monkeypatch.setattr(settings, "llm_base_url", "https://dotenv.example/v1")
    monkeypatch.setattr(settings, "llm_model", "dotenv-model")

    calls = _record_llm(monkeypatch)
    build_llm()

    assert settings.llm_configured is True
    assert calls[0]["api_key"] == "sk-from-dotenv"
    assert calls[0]["base_url"] == "https://dotenv.example/v1"
    assert calls[0]["model"] == "dotenv-model"


async def test_a_profile_without_a_key_is_refused_instead_of_borrowing_the_dotenv_one(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The dotenv key belongs to the endpoint the dotenv base URL describes. Sending it to the
    endpoint the user just configured would hand one provider another provider's credential."""
    profile = await _created(client, apiKey=None)
    monkeypatch.setattr(settings, "llm_api_key", "sk-from-dotenv")
    monkeypatch.setattr(settings, "llm_base_url", "https://dotenv.example/v1")

    calls = _record_llm(monkeypatch)
    with pytest.raises(LLMNotConfigured) as caught:
        build_llm()

    assert settings.llm_configured is False
    assert str(profile["label"]) in caught.value.detail
    assert calls == [], "nothing may be built without a credential"


async def test_a_local_profile_needs_no_key_at_all(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``local`` is the whole reason the kind exists: a server on this machine checks nothing."""
    profile = await _created(
        client,
        label="Ollama",
        kind="local",
        baseUrl="http://127.0.0.1:11434/v1",
        model="llama3.1",
        apiKey=None,
    )
    monkeypatch.setattr(settings, "llm_api_key", "")

    assert profile["kind"] == "local"
    assert profile["apiKeySet"] is False
    assert profile["apiKeyHint"] is None
    assert settings.llm_configured is True, "a local profile is complete without a key"

    calls = _record_llm(monkeypatch)
    build_llm()

    assert calls[0]["api_key"] == llm_module.NO_KEY_PLACEHOLDER
    assert calls[0]["base_url"] == "http://127.0.0.1:11434/v1"
    assert calls[0]["model"] == "llama3.1"


async def test_the_config_endpoint_follows_the_active_profile(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The composer gates on ``apiKeyConfigured``, so it has to answer for the profile a run would
    use — not for a dotenv value the run would ignore."""
    monkeypatch.setattr(settings, "llm_api_key", "")
    assert (await client.get("/api/config")).json()["apiKeyConfigured"] is False

    await _created(client)
    body = (await client.get("/api/config")).json()

    assert body["apiKeyConfigured"] is True
    assert set(body) == CONFIG_FIELDS, "the config payload gains no key field"
    assert SECRET not in json.dumps(body)


# -------------------------------------------------------------------------------------
# The Orbital gateway kind
# -------------------------------------------------------------------------------------

#: The address the client derives when it is built against the emulator: loopback by design, and
#: therefore the address that tells the two credential rules apart.
EMULATOR_BASE_URL = "http://127.0.0.1:5001/demo-orbital/us-central1/orbital/v1"


async def test_the_orbital_preset_is_served_without_a_url_or_a_key(
    client: httpx.AsyncClient,
) -> None:
    """The client derives the URL from its own Firebase project and from the emulator flag, so the
    preset must not invent one — and this is the one preset the *app* completes, not the user."""
    presets = (await client.get("/api/providers/presets")).json()["presets"]
    orbital = [preset for preset in presets if preset["id"] == "orbital"]

    assert orbital == [
        {
            "id": "orbital",
            "label": "Orbital",
            "kind": "orbital",
            "baseUrl": None,
            "model": "deepseek-v4-flash",
            "apiKeyRequired": False,
        }
    ]


async def test_an_orbital_profile_is_created_keyless_and_runs_on_the_token_it_is_given(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Nothing is pasted for this kind: the profile is created with no key and the app writes the
    account's ID token into it. With the token cleared the profile is still what a run talks to, so
    the gateway's own 401 answers — where "no API key, add one in Settings" would point the user at
    a field this kind does not have."""
    profile = await _created(
        client,
        label="Orbital",
        kind="orbital",
        baseUrl=EMULATOR_BASE_URL,
        model="deepseek-v4-flash",
        apiKey=None,
    )
    monkeypatch.setattr(settings, "llm_api_key", "")

    assert profile["kind"] == "orbital"
    assert profile["apiKeySet"] is False
    assert settings.llm_configured is True, "the account's own gateway needs nothing pasted"

    # What `useOrbitalProvider` does when the SDK hands it a fresh token.
    stored = await client.patch(
        f"/api/providers/{profile['id']}", json={"apiKey": "id-token-from-the-sdk"}
    )
    assert stored.status_code == 200, stored.text

    calls = _record_llm(monkeypatch)
    build_llm()

    assert calls[0]["api_key"] == "id-token-from-the-sdk"
    assert calls[0]["base_url"] == EMULATOR_BASE_URL
    assert calls[0]["model"] == "deepseek-v4-flash"


async def test_a_loopback_url_is_allowed_for_orbital_and_refused_for_a_cloud_kind(
    client: httpx.AsyncClient,
) -> None:
    """The gateway's emulator address is loopback by design, so the private-range refusal cannot
    apply to this kind — while a hosted provider still may not be pointed at this machine."""
    refused = await client.post("/api/providers", json=_profile(baseUrl=EMULATOR_BASE_URL))

    assert refused.status_code == 400
    assert "loopback, private or link-local" in refused.json()["detail"]

    accepted = await client.post(
        "/api/providers",
        json=_profile(label="Orbital", kind="orbital", baseUrl=EMULATOR_BASE_URL, apiKey=None),
    )

    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["profiles"][-1]["kind"] == "orbital"


# -------------------------------------------------------------------------------------
# The migration
# -------------------------------------------------------------------------------------


async def test_the_dotenv_credential_becomes_one_profile_and_is_never_imported_twice(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "llm_api_key", "sk-dotenv-1234567890")
    monkeypatch.setattr(settings, "llm_base_url", "https://opencode.ai/zen/go/v1")
    monkeypatch.setattr(settings, "llm_model", "deepseek-v4-flash")

    imported = providers.migrate_from_env()

    assert imported is not None
    assert imported.label == "opencode.ai", "the label is the host of the endpoint they were using"
    assert imported.api_key == "sk-dotenv-1234567890"
    assert imported.kind == "openai-compatible"
    assert imported.active is True
    assert providers.migrate_from_env() is None, "a second start adds nothing"

    listed = await client.get("/api/providers")
    body = listed.json()
    assert [item["label"] for item in body["profiles"]] == ["opencode.ai"]
    assert body["activeId"] == imported.id
    assert settings.llm_configured is True
    assert "sk-dotenv-1234567890" not in listed.text


async def test_migration_leaves_a_store_the_user_already_has_alone(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Including an emptied one: deleting every profile is a decision, not a missing file."""
    monkeypatch.setattr(settings, "llm_api_key", "sk-dotenv-1234567890")
    profile = await _created(client)

    assert providers.migrate_from_env() is None
    assert [item["id"] for item in (await client.get("/api/providers")).json()["profiles"]] == [
        profile["id"]
    ]

    await client.delete(f"/api/providers/{profile['id']}")
    assert providers.migrate_from_env() is None
    body = (await client.get("/api/providers")).json()
    assert body["profiles"] == []
    assert body["activeId"] is None


# -------------------------------------------------------------------------------------
# The connection test
# -------------------------------------------------------------------------------------


async def test_the_connection_test_reports_the_gateways_refusal_verbatim(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A bad key is an answer, not an error: the request succeeds and carries the endpoint's words."""
    profile = await _created(client)
    asked = _probe_transport(
        monkeypatch,
        _answers(
            401, {"error": {"message": "Invalid API key provided. Check your key and try again."}}
        ),
    )

    response = await client.post(f"/api/providers/{profile['id']}/test")
    body = response.json()

    assert response.status_code == 200
    assert body["ok"] is False
    assert body["detail"] == "Invalid API key provided. Check your key and try again."
    assert body["models"] == []
    assert [str(request.url) for request in asked] == ["https://opencode.ai/zen/v1/models"]
    assert asked[0].headers["authorization"] == f"Bearer {SECRET}"
    assert llm_module.credential_status() == (
        "rejected",
        "Invalid API key provided. Check your key and try again.",
    ), "the settings row shows the endpoint's own words about the key it refused"


async def test_the_connection_test_lists_the_models_it_found(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile = await _created(client)
    _probe_transport(
        monkeypatch,
        _answers(
            200,
            {"data": [{"id": "deepseek-v4-flash", "owned_by": "opencode"}, {"id": "deepseek-v4-pro"}]},
        ),
    )

    body = (await client.post(f"/api/providers/{profile['id']}/test")).json()

    assert body["ok"] is True
    assert body["models"] == ["deepseek-v4-flash", "deepseek-v4-pro"]
    assert "2 models" in body["detail"]
    assert llm_module.credential_status() == ("ok", None)


async def test_the_model_list_follows_the_active_profile(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two profiles are two catalogues, and the cached answer must not outlive the switch."""
    first = await _created(client, baseUrl="https://one.example/v1")
    second = await _created(client, label="Two", baseUrl="https://two.example/v1")
    asked = _probe_transport(
        monkeypatch,
        lambda request: httpx.Response(
            200, json={"data": [{"id": f"model-from-{request.url.host}"}]}
        ),
    )

    await client.post(f"/api/providers/{first['id']}/activate")
    first_body = (await client.get("/api/models")).json()
    await client.post(f"/api/providers/{second['id']}/activate")
    second_body = (await client.get("/api/models")).json()

    assert first_body["source"] == "gateway"
    assert [model["id"] for model in first_body["models"]] == ["model-from-one.example"]
    assert [model["id"] for model in second_body["models"]] == ["model-from-two.example"]
    assert [str(request.url) for request in asked] == [
        "https://one.example/v1/models",
        "https://two.example/v1/models",
    ]


# -------------------------------------------------------------------------------------
# Connecting: the provider's own list, or the preset's seed
# -------------------------------------------------------------------------------------

#: What an OpenAI-compatible ``/models`` answers with: the ids, and who owns them.
PROVIDER_MODELS = {
    "data": [
        {"id": "deepseek-v4-flash", "object": "model", "owned_by": "opencode"},
        {"id": "deepseek-v4-pro", "object": "model", "owned_by": "opencode"},
    ]
}

#: The ids the DeepSeek preset carries as its curated seed — a maintained table, not an answer.
DEEPSEEK_SEED = ["deepseek-chat", "deepseek-reasoner"]


async def _connect(client: httpx.AsyncClient, profile_id: str) -> dict[str, object]:
    response = await client.post(f"/api/providers/{profile_id}/connect")
    assert response.status_code == 200, response.text
    return response.json()


async def _stored(client: httpx.AsyncClient, profile_id: str) -> dict[str, object]:
    response = await client.get(f"/api/providers/{profile_id}/models")
    assert response.status_code == 200, response.text
    return response.json()


def _route(
    models: object, completion: Callable[[httpx.Request], httpx.Response]
) -> Callable[[httpx.Request], httpx.Response]:
    """Answer the model list and the connect's test completion differently.

    Connect makes two calls — ``/models`` and then one minimal completion — so a stub that answers
    both with the same thing cannot tell them apart, and cannot express "lists models, refuses to
    run", which is the case the probe exists for.
    """
    listed = _answers(200, models)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/chat/completions"):
            return completion(request)
        return listed(request)

    return handler


async def test_connecting_stores_the_list_the_provider_served(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile = await _created(client)
    asked = _probe_transport(monkeypatch, _answers(200, PROVIDER_MODELS))

    body = await _connect(client, profile["id"])

    assert body == {
        "ok": True,
        "detail": "2 models from https://opencode.ai/zen/v1",
        "models": ["deepseek-v4-flash", "deepseek-v4-pro"],
        "source": "provider",
    }
    assert [str(request.url) for request in asked] == [
        "https://opencode.ai/zen/v1/models",
        "https://opencode.ai/zen/v1/chat/completions",
    ], "a list only proves the endpoint will talk: connect spends one prompt proving it can run"
    assert asked[0].headers["authorization"] == f"Bearer {SECRET}"
    assert asked[0].headers["user-agent"] == llm_module.USER_AGENT, (
        "the probe identifies itself: the CDN in front of the gateway refuses a generic user "
        "agent, and that refusal is indistinguishable from a refused key once it is a verdict"
    )

    # The proving call asks the profile's own model — the one a run would use — for one token.
    proof = json.loads(asked[1].content)
    assert proof["model"] == profile["model"]
    assert proof["max_tokens"] == 1
    assert len(proof["messages"]) == 1 and proof["messages"][0]["role"] == "user"
    assert asked[1].headers["authorization"] == f"Bearer {SECRET}"
    assert asked[1].headers.get(llm_module.SESSION_HEADER), (
        "the gateway refuses a completion with no conversation id, so a probe without one is "
        "measured against a malformed request rather than against the account"
    )

    stored = await _stored(client, profile["id"])
    assert stored["models"] == ["deepseek-v4-flash", "deepseek-v4-pro"]
    assert stored["source"] == "provider"
    assert isinstance(stored["fetchedAt"], int)

    listed = (await client.get("/api/providers")).json()["profiles"][0]
    assert listed["models"] == stored["models"], "the list is on the profile, not only in the reply"
    assert listed["modelsSource"] == "provider"


async def test_connecting_a_refused_key_is_the_endpoints_words_and_stores_nothing(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile = await _created(client)
    _probe_transport(
        monkeypatch,
        _answers(
            403, {"error": {"message": "Invalid API key provided. Check your key and try again."}}
        ),
    )

    body = await _connect(client, profile["id"])

    assert body == {
        "ok": False,
        "detail": "Invalid API key provided. Check your key and try again.",
        "models": [],
        "source": "preset",
    }, "the endpoint's own words, and no list: a list would claim what this key can reach"
    assert await _stored(client, profile["id"]) == {
        "models": [],
        "source": None,
        "fetchedAt": None,
    }


@pytest.mark.parametrize(
    ("status", "message"),
    [
        (403, "AI Gateway requires a valid credit card on file to service requests."),
        (402, "your allowance is exhausted: add credits to keep running"),
    ],
)
async def test_connecting_reports_an_account_that_cannot_run(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, status: int, message: str
) -> None:
    """Listing is not running. Vercel's AI Gateway lists 391 models and refuses every completion
    until a card is on file, so a connect that stopped at the list called a blocked account
    connected and left the user to find out at the first prompt."""
    profile = await _created(client, baseUrl="https://ai-gateway.vercel.sh/v1")
    _probe_transport(
        monkeypatch,
        _route(
            PROVIDER_MODELS,
            _answers(status, {"error": {"message": message, "type": "customer_verification_required"}}),
        ),
    )

    body = await _connect(client, profile["id"])

    assert body["ok"] is False, "the account cannot make a request, and connect now knows it"
    assert body["detail"] == message, "the endpoint's own words, not a guess about the key"
    assert body["models"] == ["deepseek-v4-flash", "deepseek-v4-pro"]
    assert body["source"] == "provider"

    stored = await _stored(client, profile["id"])
    assert stored["models"] == ["deepseek-v4-flash", "deepseek-v4-pro"], (
        "what the endpoint serves is true whatever account is asking, so the list stays stored"
    )
    assert stored["source"] == "provider"


@pytest.mark.parametrize("failure", ["timeout", "server-error"])
async def test_an_unproven_completion_leaves_the_account_unjudged(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    """A no-answer is the endpoint failing at this request, not a verdict on the account — LM
    Studio on 1234 takes ~20s to answer a short reply, and a slow endpoint must neither hold the
    dialog open nor be reported as an account that cannot run."""
    profile = await _created(client)

    def completion(request: httpx.Request) -> httpx.Response:
        if failure == "timeout":
            raise httpx.ReadTimeout("the endpoint did not answer", request=request)
        return httpx.Response(502, json={"error": {"message": "bad gateway"}})

    asked = _probe_transport(monkeypatch, _route(PROVIDER_MODELS, completion))

    body = await _connect(client, profile["id"])

    assert body["ok"] is True, "a timeout or a 502 is not proof the account is blocked"
    assert "2 models from https://opencode.ai/zen/v1" in str(body["detail"])
    assert "whether it can run is unknown" in str(body["detail"])
    assert body["models"] == ["deepseek-v4-flash", "deepseek-v4-pro"]
    assert len(asked) == 2, "the list and the proof of running are two different questions"
    assert (await _stored(client, profile["id"]))["models"] == body["models"]


@pytest.mark.parametrize(
    "failure",
    ["no-such-endpoint", "connection-refused", "body-is-not-a-list"],
)
async def test_a_provider_that_will_not_list_falls_back_to_the_curated_seed(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    """An endpoint that is up but has no ``/models`` is not a verdict on the key, so the picker
    still gets a list rather than an empty dropdown."""
    profile = await _created(client, baseUrl="https://api.deepseek.com/v1")
    if failure == "connection-refused":

        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused", request=request)

    elif failure == "body-is-not-a-list":
        handler = _answers(200, {"object": "page", "nonsense": True})
    else:
        handler = _answers(404, "<html><body>404 page not found</body></html>")
    _probe_transport(monkeypatch, handler)

    body = await _connect(client, profile["id"])

    assert body["ok"] is True, "a provider that will not list is not the user's mistake"
    assert body["source"] == "preset"
    assert body["models"] == DEEPSEEK_SEED
    assert "did not serve a model list" in str(body["detail"])

    stored = await _stored(client, profile["id"])
    assert stored["models"] == DEEPSEEK_SEED
    assert stored["source"] == "preset"


@pytest.mark.parametrize(
    ("label", "kind", "base_url", "model"),
    [
        ("Orbital", "orbital", EMULATOR_BASE_URL, "deepseek-v4-flash"),
        ("Ollama", "local", "http://127.0.0.1:11434/v1", "llama3.1"),
    ],
)
async def test_a_provider_with_nothing_curated_asks_for_a_model_by_hand(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    label: str,
    kind: str,
    base_url: str,
    model: str,
) -> None:
    """These two serve ``/models`` themselves whenever they are up, so there is no seed to keep —
    and inventing one would offer the user models their own endpoint may never have had."""
    profile = await _created(
        client, label=label, kind=kind, baseUrl=base_url, model=model, apiKey=None
    )
    _probe_transport(monkeypatch, _answers(200, {"data": []}))

    body = await _connect(client, profile["id"])

    assert body["ok"] is False
    assert body["source"] == "preset"
    assert body["models"] == []
    assert "by hand" in str(body["detail"])
    assert await _stored(client, profile["id"]) == {
        "models": [],
        "source": None,
        "fetchedAt": None,
    }


async def test_the_stored_list_is_read_without_calling_the_provider(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Opening a dropdown is not a reason to make the provider answer: a slow, throttling or
    offline endpoint must not be able to empty a list the user already fetched."""
    profile = await _created(client)
    _probe_transport(monkeypatch, _answers(200, PROVIDER_MODELS))
    await _connect(client, profile["id"])

    asked = _probe_transport(monkeypatch, _answers(500, {"error": {"message": "asked again"}}))
    stored = await _stored(client, profile["id"])

    assert asked == [], "the read made a request"
    assert stored["models"] == ["deepseek-v4-flash", "deepseek-v4-pro"]
    assert stored["source"] == "provider"


async def test_an_edit_that_moves_the_endpoint_clears_the_list_that_described_it(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile = await _created(client)
    _probe_transport(monkeypatch, _answers(200, PROVIDER_MODELS))
    await _connect(client, profile["id"])
    served = ["deepseek-v4-flash", "deepseek-v4-pro"]

    async def patched(**body: object) -> dict[str, object]:
        response = await client.patch(f"/api/providers/{profile['id']}", json=body)
        assert response.status_code == 200, response.text
        return response.json()["profiles"][0]

    other_field = await patched(model="deepseek-v4-pro")
    assert other_field["models"] == served, "editing a model is not moving an endpoint"

    respelled = await patched(baseUrl="https://opencode.ai/zen/v1/")
    assert respelled["models"] == served, "a trailing slash is the same endpoint, not a new one"

    moved = await patched(baseUrl="https://elsewhere.example/v1")
    assert moved["models"] == []
    assert moved["modelsSource"] is None
    assert moved["modelsFetchedAt"] is None
    assert moved["baseUrl"] == "https://elsewhere.example/v1"


async def test_a_hand_typed_model_is_still_a_model(client: httpx.AsyncClient) -> None:
    """A provider that will not list leaves the user typing an id from its own documentation, so
    any non-blank string has to be accepted — and only a blank one refused."""
    profile = await _created(client)

    typed = (
        await client.patch(
            f"/api/providers/{profile['id']}", json={"model": "ft:mine:checkpoint-42"}
        )
    ).json()["profiles"][0]
    assert typed["model"] == "ft:mine:checkpoint-42"

    blank = await client.patch(f"/api/providers/{profile['id']}", json={"model": "   "})
    assert blank.status_code == 400
    assert "needs a model" in blank.json()["detail"]


# -------------------------------------------------------------------------------------
# What the client is told, and what it is refused
# -------------------------------------------------------------------------------------


async def test_the_presets_are_exactly_what_a_profile_may_be_created_from(
    client: httpx.AsyncClient,
) -> None:
    """Phase 3 renders this list and hardcodes nothing, so every entry has to be accepted as sent.

    Every entry but ``orbital``: its base URL is the client's to compute, because it is built from
    the app's own Firebase project and from whether that build uses the emulator. It is created the
    same way, with the URL the client derived, in the test just above.
    """
    presets = (await client.get("/api/providers/presets")).json()["presets"]
    derived = [preset for preset in presets if preset["id"] != "orbital"]

    assert {preset["id"] for preset in presets} == {
        "opencode-go",
        "zen",
        "openai",
        "anthropic",
        "gemini",
        "grok",
        "deepseek",
        "vercel",
        "orbital",
        "ollama",
        "lmstudio",
    }
    assert all(preset["baseUrl"].startswith("http") for preset in derived)
    assert all(preset["model"] for preset in presets)
    assert {preset["kind"] for preset in presets} == {"openai-compatible", "orbital", "local"}
    assert all(
        preset["apiKeyRequired"] is (preset["id"] not in {"orbital", "ollama", "lmstudio"})
        for preset in presets
    ), "only the account's own gateway and a local endpoint answer without a pasted key"

    for preset in derived:
        created = await client.post("/api/providers", json=preset)
        assert created.status_code == 200, created.text
    assert len((await client.get("/api/providers")).json()["profiles"]) == len(derived)


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"kind": "telepathy"}, "unknown provider kind 'telepathy'"),
        ({"baseUrl": "   "}, "needs a base URL"),
        ({"baseUrl": "opencode.ai/zen/v1"}, "must be an http:// or https:// URL"),
        ({"baseUrl": "http://"}, "must be an http:// or https:// URL"),
        ({"label": "  "}, "needs a label"),
        ({"model": ""}, "needs a model"),
    ],
)
async def test_a_profile_the_backend_cannot_use_is_refused_with_a_reason(
    client: httpx.AsyncClient, overrides: dict[str, object], expected: str
) -> None:
    response = await client.post("/api/providers", json=_profile(**overrides))

    assert response.status_code == 400
    assert expected in response.json()["detail"]
    assert (await client.get("/api/providers")).json()["profiles"] == []


async def test_an_edit_that_is_refused_leaves_the_profile_as_it_was(
    client: httpx.AsyncClient,
) -> None:
    profile = await _created(client)

    response = await client.patch(
        f"/api/providers/{profile['id']}", json={"model": "ok-model", "baseUrl": "not a url"}
    )

    assert response.status_code == 400
    stored = (await client.get("/api/providers")).json()["profiles"][0]
    assert stored["model"] == "deepseek-v4-flash", "a refused edit must not apply in part"


async def test_an_unknown_profile_is_a_404_for_every_verb(client: httpx.AsyncClient) -> None:
    responses = [
        await client.patch("/api/providers/missing", json={"label": "x"}),
        await client.delete("/api/providers/missing"),
        await client.post("/api/providers/missing/activate"),
        await client.post("/api/providers/missing/test"),
        await client.post("/api/providers/missing/connect"),
        await client.get("/api/providers/missing/models"),
    ]

    assert [response.status_code for response in responses] == [404] * len(responses)
    assert all("missing" in response.json()["detail"] for response in responses)


# -------------------------------------------------------------------------------------
# A run pinned to one provider
# -------------------------------------------------------------------------------------

#: Distinct from ``SECRET`` so that which credential reached the client is unambiguous.
PINNED_SECRET = "sk-pinned-0f1e2d3c4b5a6e7d"


async def _pin(
    client: httpx.AsyncClient, **overrides: object
) -> dict[str, object]:
    """A second profile with its own endpoint, key and model — the one a run is pinned to."""
    body: dict[str, object] = {
        "label": "Pinned",
        "baseUrl": "https://pinned.example/v1",
        "model": "pinned-model",
        "apiKey": PINNED_SECRET,
    }
    body.update(overrides)
    return await _created(client, **body)


def _record_starts(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, object]]:
    """Capture what the routes hand the runner, instead of running anything."""
    started: list[dict[str, object]] = []

    async def record(*args: object, **kwargs: object) -> None:
        started.append(kwargs)

    monkeypatch.setattr(runner_module, "start_run", record)
    monkeypatch.setattr(runner_module, "start_chat", record)
    return started


class ScriptedChatModel(BaseChatModel):
    """A canned chat model, so a whole turn can run without a socket (as in test_agents)."""

    reply: str = "answered by the pinned provider"

    @property
    def _llm_type(self) -> str:
        return "orbital-scripted-pinned"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ScriptedChatModel":
        return self

    def _generate(
        self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any
    ) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=self.reply))])

    async def _astream(
        self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any
    ) -> AsyncIterator[ChatGenerationChunk]:
        for token in self.reply.split(" "):
            yield ChatGenerationChunk(message=AIMessageChunk(content=f"{token} "))


async def test_a_turn_pinned_to_a_provider_builds_every_model_on_that_profile(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, sample_project
) -> None:
    """The active profile has **no key**, so a turn that reached it could not start: the turn
    completing is itself the evidence that the pin, not the active profile, supplied the endpoint.
    """
    active = await _created(client, apiKey=None)
    pinned = await _pin(client)
    chosen: list[object] = []

    def build(**kwargs: object) -> ScriptedChatModel:
        chosen.append(kwargs.get("profile"))
        return ScriptedChatModel()

    monkeypatch.setattr(graph_module, "build_llm", build)
    monkeypatch.setattr(graph_module, "tools_for", lambda agent, ctx: [])
    monkeypatch.setattr(llm_module, "_credential_state", "unknown")
    monkeypatch.setattr(llm_module, "_credential_detail", None)

    await runner_module.start_chat(
        "pinned-session",
        Phase.PLAN,
        "hello",
        str(sample_project),
        provider=providers.find(str(pinned["id"])),
    )

    assert [getattr(profile, "id", None) for profile in chosen] == [pinned["id"]], (
        "the pinned profile has to reach every model the turn builds, not just the first"
    )
    state = sessions.get("pinned-session")
    assert state.status is RunStatus.IDLE, state.error
    assert any(
        ScriptedChatModel().reply in str(message.content) for message in state.messages
    ), "the turn did not run"
    assert llm_module.credential_status() == ("unknown", None), (
        "another provider's answer is no verdict on the active profile's key"
    )

    listed = (await client.get("/api/providers")).json()
    assert listed["activeId"] == active["id"], "a pin is the run's choice, not a settings edit"
    after = next(profile for profile in listed["profiles"] if profile["id"] == pinned["id"])
    assert after["apiKeySet"] is True
    assert after["model"] == "pinned-model"


async def test_the_client_is_built_from_the_profile_it_is_given(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``build_llm`` takes the profile rather than reading the active one: that is the whole
    reason a chat can be pinned to a provider other than the one the badge sits on."""
    active = await _created(client)
    pinned = await _pin(client)

    calls = _record_llm(monkeypatch)
    build_llm(profile=providers.find(str(pinned["id"])))

    assert calls[0]["api_key"] == PINNED_SECRET, "the pinned profile's key, not the active one's"
    assert calls[0]["base_url"] == "https://pinned.example/v1"
    assert calls[0]["model"] == "pinned-model"

    calls.clear()
    build_llm()

    assert calls[0]["api_key"] == SECRET
    assert calls[0]["base_url"] == active["baseUrl"]
    assert calls[0]["model"] == "deepseek-v4-flash"


async def test_a_pinned_profile_without_a_key_refuses_the_run_by_its_own_name(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The active profile is complete; the pinned one is not. The message has to name the profile
    that is actually missing the key, or the user goes looking somewhere the fix is not."""
    await _created(client)
    pinned = await _pin(client, label="Needs a key", apiKey=None)
    calls = _record_llm(monkeypatch)

    with pytest.raises(LLMNotConfigured) as caught:
        build_llm(profile=providers.find(str(pinned["id"])))

    assert "Needs a key" in caught.value.detail
    assert calls == [], "nothing may be built on a profile with no credential"


async def test_a_pinned_run_hands_the_runner_that_profile(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, sample_project
) -> None:
    """The route resolves the id before anything is scheduled, and hands the runner the profile
    itself — its URL, its key and its model — leaving the active profile where it was."""
    active = await _created(client)
    pinned = await _pin(client)
    started = _record_starts(monkeypatch)

    response = await client.post(
        "/api/agents/run",
        json={
            "sessionId": "pinned-route",
            "phase": "plan",
            "prompt": "plan it",
            "projectPath": str(sample_project),
            "providerId": pinned["id"],
        },
    )

    assert response.status_code == 200, response.text
    await _handed_over(started)
    handed = started[0]["provider"]
    assert getattr(handed, "id", None) == pinned["id"]
    assert getattr(handed, "base_url", None) == "https://pinned.example/v1"
    assert getattr(handed, "model", None) == "pinned-model"
    assert getattr(handed, "api_key", None) == PINNED_SECRET

    listed = (await client.get("/api/providers")).json()
    assert listed["activeId"] == active["id"]
    assert PINNED_SECRET not in json.dumps(listed), "the pin changed nothing about the wire"


async def test_an_unknown_provider_id_is_a_400_naming_it(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, sample_project
) -> None:
    started = _record_starts(monkeypatch)
    common = {"sessionId": "unknown-provider", "phase": "plan", "projectPath": str(sample_project)}

    run = await client.post(
        "/api/agents/run",
        json={**common, "prompt": "plan it", "providerId": "no-such-profile"},
    )
    chat = await client.post(
        "/api/agents/chat",
        json={**common, "message": "hello", "providerId": "no-such-profile"},
    )

    assert [run.status_code, chat.status_code] == [400, 400]
    assert "no-such-profile" in run.json()["detail"]
    assert "no-such-profile" in chat.json()["detail"]
    await asyncio.sleep(0)
    assert started == [], "an id that names nothing must not start anything"
    assert (await client.get("/api/providers")).json()["profiles"] == []


async def _handed_over(started: list[dict[str, object]]) -> None:
    """Wait for the run the route scheduled in the background, so the recorder has been called."""
    for _ in range(10):
        if started:
            return
        await asyncio.sleep(0)
    raise AssertionError("the route never handed the run to the runner")


# -------------------------------------------------------------------------------------
# The file
# --------------------------------------------------------------------------------------


async def test_the_store_is_readable_by_the_owner_alone(client: httpx.AsyncClient) -> None:
    """The file holds keys, so unlike the project registry it sets its own permissions."""
    await _created(client)
    path = provider_file()

    assert path.exists()
    if sys.platform == "win32":
        listing = subprocess.run(
            ["icacls", str(path)], capture_output=True, text=True, check=True
        ).stdout
        assert os.environ["USERNAME"] in listing
        assert "(I)" not in listing, "an inherited entry is a permission this file did not set"
        for other in ("BUILTIN\\Users", "Everyone", "Authenticated Users"):
            assert other not in listing
    else:
        assert path.stat().st_mode & 0o777 == 0o600
