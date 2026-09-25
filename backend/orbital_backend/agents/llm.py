"""LLM construction for every Orbital agent.

One model endpoint serves all four agents: an OpenAI-compatible chat-completions endpoint
(OpenCode Go by default) hosting `deepseek-v4-flash`. Nothing here is cached — a run is
long-lived and the model object is cheap, while a cached client would survive a settings
reload and keep pointing at a stale key.

Two non-obvious requirements of the OpenCode Go gateway are handled here:

* it asks clients to identify themselves rather than masquerade as a generic SDK, and
* it requires a stable per-conversation id in ``x-opencode-session`` to route requests and
  reuse prompt caches. Omitting it is a 400, not a degraded experience — verified against
  the live gateway.

Both are harmless on any other OpenAI-compatible endpoint, which ignores unknown headers,
so they are always sent rather than made configurable.
"""

from __future__ import annotations

import time
from typing import Literal

import httpx
from langchain_openai import ChatOpenAI

from orbital_backend.config import settings
from orbital_backend.errors import LLMNotConfigured, logger, provider_message
from orbital_backend.models import BACKEND_VERSION, ModelInfo

from .retry import is_credential_failure

_log = logger(__name__)

# A single agent turn may legitimately take a while on a long file write; the transport
# timeout is deliberately generous and independent of the shell timeout.
LLM_REQUEST_TIMEOUT_SECONDS = 180.0

#: Identifies Orbital to the gateway.
USER_AGENT = f"orbital-ide/{BACKEND_VERSION}"

#: Conversation identity for routing and prompt-cache reuse.
SESSION_HEADER = "x-opencode-session"

_ENDPOINT_SUFFIX = "/chat/completions"


def endpoint_base(url: str) -> str:
    """Normalise a configured base URL to what the OpenAI client expects.

    The gateway documentation publishes full endpoints (``…/v1/chat/completions``), so that
    is what people paste; the client appends the path itself and would otherwise request
    ``…/chat/completions/chat/completions``.
    """
    base = url.strip().rstrip("/")
    if base.endswith(_ENDPOINT_SUFFIX):
        base = base[: -len(_ENDPOINT_SUFFIX)]
    return base.rstrip("/")


def build_llm(
    *,
    session_id: str | None = None,
    temperature: float = 0.2,
    max_tokens: int | None = None,
    model: str | None = None,
    reasoning_effort: str | None = None,
) -> ChatOpenAI:
    """Return a chat model bound to the configured endpoint.

    Args:
        session_id: Orbital session id, sent as the gateway's conversation id. One Orbital
            session is one conversation, including a run that advances through phases.
        temperature: Sampling temperature for the caller's role.
        max_tokens: Output ceiling for this role. Defaults to ``ORBITAL_LLM_MAX_TOKENS``.
        model: Model id for this run, overriding ``ORBITAL_LLM_MODEL``.
        reasoning_effort: How hard the model should think, as OpenAI spells it. ``None``
            deliberately passes no parameter: a gateway that does not know it may reject the
            request, so "unset" has to mean "absent from the payload", not "sent as null".

    Raises:
        LLMNotConfigured: when no API key is present. The API layer turns this into a 503
            (REST) or an ``agent.error`` frame (WebSocket) instead of letting the graph fail
            halfway through a run.
    """
    if not settings.llm_configured:
        raise LLMNotConfigured(
            "ORBITAL_LLM_API_KEY is not set. Export it (or add it to .env) and restart the "
            "backend before running an agent."
        )
    headers = {"User-Agent": USER_AGENT}
    if session_id:
        headers[SESSION_HEADER] = session_id
    limit = settings.llm_max_tokens if max_tokens is None else max_tokens
    effort = {"reasoning_effort": reasoning_effort} if reasoning_effort else {}
    return ChatOpenAI(
        model=model or settings.llm_model,
        base_url=endpoint_base(settings.llm_base_url),
        api_key=settings.llm_api_key,
        temperature=temperature,
        timeout=LLM_REQUEST_TIMEOUT_SECONDS,
        max_retries=2,
        max_tokens=limit if limit > 0 else None,
        default_headers=headers,
        **effort,
    )


#: How much of the gateway's refusal to keep. It ends up in a chat bubble and a settings row.
_AUTH_DETAIL_LIMIT = 160


def _auth_detail(exc: BaseException) -> str:
    """The gateway's own words about the refusal, for the fail-fast message and the UI."""
    response = getattr(exc, "response", None)
    body = getattr(response, "text", "") or str(exc)
    return (provider_message(body) or " ".join(body.split()))[:_AUTH_DETAIL_LIMIT]


#: What the last authenticated call revealed about the configured key. Presence is checked
#: from settings on every call rather than stored, because the key can be changed at runtime
#: through the settings page — a cached "missing" would outlive the fix.
CredentialState = Literal["unknown", "ok", "rejected"]

_credential_state: CredentialState = "unknown"
_credential_detail: str | None = None


def note_credential(state: CredentialState, detail: str | None = None) -> None:
    """Record what an authenticated call to the gateway revealed about the key."""
    global _credential_state, _credential_detail
    if state == _credential_state and detail == _credential_detail:
        return
    _credential_state, _credential_detail = state, detail
    _log.info("gateway credential state: %s%s", state, f" ({detail})" if detail else "")


def credential_status() -> tuple[CredentialState, str | None]:
    """The last known credential state, with the gateway's own words when it refused."""
    return _credential_state, _credential_detail


def assert_llm_available() -> None:
    """Fail fast when no key is configured, so the UI gets a clear message before any work.

    A key that is present but *refused* is deliberately **not** refused here. The verdict is a
    past observation, not a fact about the key now: the key can be replaced at any moment (the
    settings page writes it and clears the verdict), and one refused call is not proof the key is
    bad — a gateway, a proxy or a rotated credential can all produce one. Blocking on it would
    let a single failure stop work that would succeed on the next attempt. The verdict is
    recorded for the settings page and the logs instead, and retrying stays the user's call.
    """
    if not settings.llm_configured:
        raise LLMNotConfigured(
            "ORBITAL_LLM_API_KEY is not set. Agent runs are disabled until a key is configured."
        )


#: Offered when the gateway cannot be reached, so the picker is never empty.
FALLBACK_MODELS: tuple[str, ...] = ("deepseek-v4-flash", "deepseek-v4-pro")

#: The catalogue changes rarely; a short cache keeps opening the picker off the network.
MODEL_CACHE_TTL_SECONDS = 300.0

_model_cache: tuple[float, tuple[ModelInfo, ...], str] | None = None


async def fetch_models(*, force: bool = False) -> tuple[list[ModelInfo], str]:
    """List the models the configured endpoint offers, and where the list came from.

    Read live so the picker shows what this key can actually reach, cached briefly, and backed
    by a short static list so the UI still works when the gateway is unreachable. The gateway's
    entries carry no context length, which is why ``ORBITAL_CONTEXT_WINDOW`` is configured.
    """
    global _model_cache
    now = time.monotonic()
    if not force and _model_cache is not None and now - _model_cache[0] < MODEL_CACHE_TTL_SECONDS:
        return list(_model_cache[1]), _model_cache[2]

    def fallback(reason: str) -> tuple[list[ModelInfo], str]:
        _log.info("using the fallback model list: %s", reason)
        return [ModelInfo(id=name, owned_by=None) for name in FALLBACK_MODELS], "fallback"

    if not settings.llm_configured:
        return fallback("no API key configured")

    url = f"{endpoint_base(settings.llm_base_url)}/models"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                url,
                headers={
                    "Authorization": f"Bearer {settings.llm_api_key}",
                    "User-Agent": USER_AGENT,
                },
            )
            response.raise_for_status()
            payload: object = response.json()
    except Exception as exc:  # noqa: BLE001 - the picker degrades, it does not fail
        # This is an authenticated call, so its outcome is the cheapest evidence available about
        # whether the key works — and it is asked for anyway when the picker opens.
        if is_credential_failure(exc):
            note_credential("rejected", _auth_detail(exc))
        return fallback(f"{type(exc).__name__} from {url}")

    entries = payload.get("data") if isinstance(payload, dict) else payload
    models: list[ModelInfo] = []
    if isinstance(entries, list):
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            identifier = entry.get("id")
            if not isinstance(identifier, str) or not identifier:
                continue
            owner = entry.get("owned_by")
            models.append(ModelInfo(id=identifier, owned_by=owner if isinstance(owner, str) else None))
    if not models:
        return fallback("the gateway returned no model ids")

    _model_cache = (now, tuple(models), "gateway")
    note_credential("ok")
    return list(models), "gateway"
