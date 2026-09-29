"""LLM construction for every Orbital agent.

One model endpoint serves all four agents: an OpenAI-compatible chat-completions endpoint
hosting `deepseek-v4-flash` unless another model is named. Which endpoint that is comes from the
*active provider profile* — the endpoint, the key and the default model all come from it — and
falls back to the ``ORBITAL_LLM_*`` settings when the user has configured no profile, which is
what a fresh clone has. Nothing here is cached — a run is long-lived and the model object is
cheap, while a cached client would survive a settings reload and keep pointing at a stale key.

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
from dataclasses import dataclass
from typing import Literal

import httpx
from langchain_openai import ChatOpenAI

from orbital_backend.config import settings
from orbital_backend.errors import LLMNotConfigured, logger, provider_message
from orbital_backend.models import BACKEND_VERSION, ModelInfo, ProviderProfile
from orbital_backend.services.providers import profile_is_usable, providers

from .retry import is_credential_failure

_log = logger(__name__)

# A single agent turn may legitimately take a while on a long file write; the transport
# timeout is deliberately generous and independent of the shell timeout.
LLM_REQUEST_TIMEOUT_SECONDS = 180.0

#: How long the model probe waits. It is one cheap call, and the settings page is waiting on it,
#: so this is short enough to answer a dead endpoint quickly.
PROBE_TIMEOUT_SECONDS = 15.0

#: Sent as the key for an endpoint that needs none. The OpenAI client refuses to be constructed
#: without one, and a local server ignores whatever it is given; a credential check refuses the
#: run before this value could ever be sent to an endpoint that does check.
NO_KEY_PLACEHOLDER = "not-needed"

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


@dataclass(frozen=True)
class Endpoint:
    """One place a run can talk to: where, with which key, and which model by default."""

    base_url: str
    api_key: str
    model: str


def endpoint_for(profile: ProviderProfile) -> Endpoint:
    """The endpoint a stored profile points at.

    A profile with no key still gets one here: ``local`` is the kind that needs none, and the
    OpenAI client refuses to be constructed without a string. The credential check is what keeps
    that placeholder away from an endpoint that would check it.
    """
    key = (profile.api_key or "").strip()
    return Endpoint(
        base_url=profile.base_url,
        api_key=key or NO_KEY_PLACEHOLDER,
        model=profile.model,
    )


def profile_endpoint(profile: ProviderProfile) -> Endpoint | None:
    """The endpoint one profile points at, or ``None`` when that profile is not finished."""
    return endpoint_for(profile) if profile_is_usable(profile) else None


def active_endpoint() -> Endpoint | None:
    """The endpoint the next run talks to, or ``None`` when there is nothing to talk to.

    The active profile wins whenever there is one, and it must be finished: a profile the user has
    not given a key yet has nothing to talk to, and the dotenv key is deliberately **not**
    substituted for it, because that key belongs to the endpoint ``.env`` describes — sending it
    to the user's new endpoint would hand one provider another provider's credential. With no
    profile this is the ``ORBITAL_LLM_*`` configuration, exactly as before profiles.

    Read on every call rather than held: the user can change the active profile at any moment, and
    a remembered endpoint would keep a run on the one they just replaced. A run *pinned* to a
    profile does not come through here at all — see :func:`require_endpoint`.
    """
    profile = providers.active()
    if profile is not None:
        return profile_endpoint(profile)
    if not settings.llm_api_key.strip():
        return None
    return Endpoint(
        base_url=settings.llm_base_url,
        api_key=settings.llm_api_key,
        model=settings.llm_model,
    )


def _missing_credential(profile: ProviderProfile | None = None) -> LLMNotConfigured:
    """The refusal to raise, naming the thing the user has to add.

    The profile named here is the one the refused run would have talked to — the active one, unless
    the caller pinned the run to another — so the message points at the profile to fix rather than
    at whichever one happens to hold the active badge.
    """
    named = providers.active() if profile is None else profile
    if named is None:
        return LLMNotConfigured(
            "ORBITAL_LLM_API_KEY is not set. Export it (or add it to .env) and restart the "
            "backend before running an agent."
        )
    return LLMNotConfigured(
        f"the provider profile {named.label!r} has no API key: add one in Settings "
        "before running an agent."
    )


def require_endpoint(profile: ProviderProfile | None = None) -> Endpoint:
    """The endpoint for a run, or the refusal that says what is missing.

    ``profile`` is the profile a run is pinned to — its base URL, its key and its model, with the
    active profile left exactly where it was. ``None`` is every run that names no provider: the
    active profile, or the ``ORBITAL_LLM_*`` settings when there is none.
    """
    target = active_endpoint() if profile is None else profile_endpoint(profile)
    if target is None:
        raise _missing_credential(profile)
    return target


def build_llm(
    *,
    session_id: str | None = None,
    temperature: float = 0.2,
    max_tokens: int | None = None,
    model: str | None = None,
    reasoning_effort: str | None = None,
    profile: ProviderProfile | None = None,
) -> ChatOpenAI:
    """Return a chat model bound to one endpoint.

    Args:
        session_id: Orbital session id, sent as the gateway's conversation id. One Orbital
            session is one conversation, including a run that advances through phases.
        temperature: Sampling temperature for the caller's role.
        max_tokens: Output ceiling for this role. Defaults to ``ORBITAL_LLM_MAX_TOKENS``.
        model: Model id for this run, overriding the profile's model.
        reasoning_effort: How hard the model should think, as OpenAI spells it. ``None``
            deliberately passes no parameter: a gateway that does not know it may reject the
            request, so "unset" has to mean "absent from the payload", not "sent as null".
        profile: The provider profile this model talks to, for a run pinned to one. ``None`` is
            the active profile — or the ``ORBITAL_LLM_*`` settings on a machine with no profiles,
            exactly as before profiles existed. The caller passes the profile rather than this
            reading it, because a pinned run must not be able to pick the active one up by
            accident halfway through.

    Raises:
        LLMNotConfigured: when there is nothing to talk to — no active profile and no dotenv key,
            or the named profile has no key yet. The API layer turns this into a 503 (REST) or an
            ``agent.error`` frame (WebSocket) instead of letting the graph fail halfway through a
            run.
    """
    target = require_endpoint(profile)
    headers = {"User-Agent": USER_AGENT}
    if session_id:
        headers[SESSION_HEADER] = session_id
    limit = settings.llm_max_tokens if max_tokens is None else max_tokens
    effort = {"reasoning_effort": reasoning_effort} if reasoning_effort else {}
    return ChatOpenAI(
        model=model or target.model,
        base_url=endpoint_base(target.base_url),
        api_key=target.api_key,
        temperature=temperature,
        timeout=LLM_REQUEST_TIMEOUT_SECONDS,
        max_retries=2,
        max_tokens=limit if limit > 0 else None,
        default_headers=headers,
        **effort,
    )


#: How much of a refusal is repeated in the *UI*: the settings row's verdict and the connect
#: dialog. Long enough that a provider's advice survives whole — a refusal often ends in the URL
#: that fixes it ("… add a card and unlock your free credits. Please visit https://…"), and a link
#: cut in half is worse than none. Short enough to stay a readable couple of lines.
#:
#: The *stored* credential verdict is built elsewhere (``describe_failure``) and keeps its own
#: limit; this one is only ever shown to the person reading the screen.
_AUTH_DETAIL_LIMIT = 300

#: What replaces the credential in anything derived from a provider's own words.
_REDACTED = "[redacted]"


def _known_api_keys() -> tuple[str, ...]:
    """Every credential this process holds, for redacting text a provider wrote.

    More than one, because more than one can be live at once: a run pinned to a profile sends
    *that* profile's key, so a failure from it may echo a key the active profile knows nothing
    about, and redacting against the active profile's alone would leave it in the error the user is
    shown and the log keeps. The dotenv key is in here too — a machine with no profiles still has
    one — and a key that appears twice (the migration copies it into a profile and blanks the
    file) is deduplicated, because replacing it twice proves nothing.
    """
    keys = [settings.llm_api_key.strip()]
    keys.extend((profile.api_key or "").strip() for profile in providers.list())
    return tuple(key for key in dict.fromkeys(keys) if key)


def redact_credential(text: str, api_key: str | None = None) -> str:
    """Strip a credential out of text a provider wrote, before it is stored, returned or logged.

    A gateway that echoes the key it refused is common, and this text travels to the settings row,
    to ``/api/health`` and to the log. The full key and its last eight characters are both removed:
    providers quote the tail back ("key …a1b2c3d4 is invalid") far more often than the whole thing.

    ``api_key`` names the one credential to redact when the caller knows which one was sent.
    ``None`` redacts against every credential this process holds, which is the right default for a
    caller reporting a failure: the text came from an endpoint that one of them was sent to, and
    which one is not something an error path should have to know to keep the secret out.
    """
    candidates = _known_api_keys() if api_key is None else (api_key.strip(),)
    for key in candidates:
        if not key:
            continue
        text = text.replace(key, _REDACTED)
        if len(key) > 8:
            text = text.replace(key[-8:], _REDACTED)
    return text


def _auth_detail(exc: BaseException, api_key: str) -> str:
    """The gateway's own words about the refusal, for the fail-fast message and the UI."""
    response = getattr(exc, "response", None)
    body = getattr(response, "text", "") or str(exc)
    detail = provider_message(body) or " ".join(body.split())
    # Redacted before the truncation: cutting a key in half would leave a fragment that no longer
    # matches the whole key and would survive the scrub.
    return redact_credential(detail, api_key)[:_AUTH_DETAIL_LIMIT]


#: What the last authenticated call revealed about the configured key. Presence is checked
#: from settings on every call rather than stored, because the key can be changed at runtime
#: through the settings page — a cached "missing" would outlive the fix.
CredentialState = Literal["unknown", "ok", "rejected"]

_credential_state: CredentialState = "unknown"
_credential_detail: str | None = None


def note_credential(state: CredentialState, detail: str | None = None) -> None:
    """Record what an authenticated call to the gateway revealed about the key.

    The one place that decides what is kept about a refusal, and it is kept in three: the settings
    row, ``/api/health`` and the log. The credential is stripped here as well as where the text was
    built, because a provider that echoes the key it refused must not have it preserved anywhere
    the user or a log reader can see.
    """
    global _credential_state, _credential_detail
    if detail is not None:
        detail = redact_credential(detail)
    if state == _credential_state and detail == _credential_detail:
        return
    _credential_state, _credential_detail = state, detail
    _log.info("gateway credential state: %s%s", state, f" ({detail})" if detail else "")


def credential_status() -> tuple[CredentialState, str | None]:
    """The last known credential state, with the gateway's own words when it refused."""
    return _credential_state, _credential_detail


def describes_active_credential(profile: ProviderProfile | None) -> bool:
    """Whether a run's outcome says anything about the *active* profile's credential.

    The stored verdict is about the profile a run would use by default — that is what the settings
    row and ``/api/health`` claim — so a run pinned to another provider must not write one: it was
    answered by the pinned profile's key, and recording its refusal would tell the user their
    working key is rejected because a different endpoint refused a different one. ``None`` is a run
    that named no profile, which speaks for the active one and, on a machine with no profiles at
    all, for the dotenv key.
    """
    active = providers.active()
    if profile is None:
        return active is None
    return active is not None and active.id == profile.id


def assert_llm_available(profile: ProviderProfile | None = None) -> None:
    """Fail fast when no credential is configured, so the UI gets a clear message before any work.

    ``profile`` is the profile a run is pinned to, if any; ``None`` checks the active profile or the
    dotenv settings. Either way this asks only whether there is something to talk to — never
    whether the key works.

    A key that is present but *refused* is deliberately **not** refused here. The verdict is a
    past observation, not a fact about the key now: the key can be replaced at any moment (the
    settings page writes it and clears the verdict), and one refused call is not proof the key is
    bad — a gateway, a proxy or a rotated credential can all produce one. Blocking on it would
    let a single failure stop work that would succeed on the next attempt. The verdict is
    recorded for the settings page and the logs instead, and retrying stays the user's call.
    """
    require_endpoint(profile)


#: Offered when the gateway cannot be reached, so the picker is never empty.
FALLBACK_MODELS: tuple[str, ...] = ("deepseek-v4-flash", "deepseek-v4-pro")

#: The catalogue changes rarely; a short cache keeps opening the picker off the network. The
#: identity is part of the entry, because the cache answers one endpoint's question and switching
#: the active profile must not serve the previous profile's answer.
MODEL_CACHE_TTL_SECONDS = 300.0

_ModelCacheKey = tuple[str, str]
_model_cache: tuple[float, tuple[ModelInfo, ...], str, _ModelCacheKey] | None = None


def _cache_key(target: Endpoint) -> _ModelCacheKey:
    """What makes two probes the same question: the endpoint, and the key it is asked with.

    The key is part of a process-memory key — never logged, never serialised — and it has to be
    there: two profiles may share a base URL and differ only in the key, and they can offer
    different models.
    """
    return endpoint_base(target.base_url), target.api_key


@dataclass(frozen=True)
class ModelsProbe:
    """What one authenticated call to an endpoint's ``/models`` revealed.

    ``detail`` is the endpoint's *own* words when it refused — a bad key is an answer to show the
    user, not an exception to swallow — and ``None`` when the call succeeded.
    """

    models: tuple[ModelInfo, ...] = ()
    detail: str | None = None
    #: True when the endpoint refused on the credential's account, so the verdict recorded for the
    #: settings page is about the key rather than about the network.
    rejected: bool = False


async def probe_models(target: Endpoint) -> ModelsProbe:
    """Ask an endpoint which models it offers, authenticated with the given key.

    One cheap authenticated call, which is what makes it the right shape for the settings page's
    connection test as well as for the picker: it answers "is this endpoint reachable with this
    key, and what does it serve" in one request.
    """
    url = f"{endpoint_base(target.base_url)}/models"
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_SECONDS) as client:
            response = await client.get(
                url,
                headers={
                    "Authorization": f"Bearer {target.api_key}",
                    "User-Agent": USER_AGENT,
                },
            )
            response.raise_for_status()
            payload: object = response.json()
    except Exception as exc:  # noqa: BLE001 - the caller reports this; it is not a crash
        if is_credential_failure(exc):
            return ModelsProbe(detail=_auth_detail(exc, target.api_key), rejected=True)
        return ModelsProbe(detail=f"{type(exc).__name__} from {url}")

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
    return ModelsProbe(models=tuple(models))


#: The one user turn the connect probe sends. What it asks is pointless and that is the point: the
#: endpoint's credential, entitlement and allowance checks all run before a request is served, so
#: *any* request it accepts proves the account can make one.
_COMPLETION_PROBE_PROMPT = "ping"

#: The conversation id the probe claims. A run always has an Orbital session id and sends it as
#: ``x-opencode-session``; the gateway refuses a completion without one ("cannot be routed
#: efficiently"). A probe that left it out would be measuring its own malformed request instead of
#: the account, so it names itself instead, on every provider — an endpoint that does not know the
#: header ignores it.
_COMPLETION_PROBE_SESSION = "orbital-connect-probe"


@dataclass(frozen=True)
class CompletionProbe:
    """What one minimal completion revealed about whether an account can actually run.

    ``detail`` is the endpoint's own words when it refused — the same words the settings row shows
    for a refused key — and ``None`` when it accepted the request. ``unproven`` marks the outcomes
    that are *not* a verdict on the account at all: no answer came back, so there is nothing to
    report and the caller must not call the account blocked on it.
    """

    detail: str | None = None
    unproven: bool = False


async def probe_completion(target: Endpoint) -> CompletionProbe:
    """Ask for the smallest possible completion, to find out whether this account may make one.

    ``/models`` is a read, and a gateway will serve it to an account that cannot run a single
    request: Vercel's AI Gateway lists 391 models and then refuses every completion until a credit
    card is on file. Connect therefore spends one prompt's worth of usage — one output token, which
    is 0.5 credit on the ``orbital`` kind, where an account without allowance now hears the
    gateway's 402 here instead of at the first prompt — asking the endpoint to answer *something*.

    The profile's own ``model`` is the one asked for, because it is the one a run would use: an
    account entitled to some other model would still fail every run started from this profile.
    The request carries the headers a run would send it, session id included — see
    :data:`_COMPLETION_PROBE_SESSION` — so that what comes back is the endpoint's verdict on the
    account rather than on a request only the probe would make.

    Only one outcome means the account is unable to run: the endpoint answered with a 4xx, i.e. it
    understood the request and refused it (a refused key, a missing entitlement, an exhausted
    allowance). A 5xx, a timeout or a transport failure is the endpoint failing at this particular
    request, which says nothing about the account, so it comes back unproven.
    """
    url = f"{endpoint_base(target.base_url)}/chat/completions"
    payload = {
        "model": target.model,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": _COMPLETION_PROBE_PROMPT}],
    }
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_SECONDS) as client:
            response = await client.post(
                url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {target.api_key}",
                    "User-Agent": USER_AGENT,
                    SESSION_HEADER: _COMPLETION_PROBE_SESSION,
                },
            )
            response.raise_for_status()
    except httpx.TimeoutException:
        # Same timeout the models probe gets, and it is deliberately not raised for this call: a
        # slow local endpoint (LM Studio on 1234 with a cold model takes ~20s) must not hold the
        # connect dialog open, and it must not be reported as an account that cannot run when all
        # it did was fail to answer in time.
        return CompletionProbe(
            detail=f"no answer to a test completion within {PROBE_TIMEOUT_SECONDS:g}s", unproven=True
        )
    except httpx.HTTPStatusError as exc:
        # A 5xx is the endpoint failing at this request, not refusing it on the account's behalf, so
        # its words are still worth reporting but they are not a verdict on the account.
        return CompletionProbe(
            detail=_auth_detail(exc, target.api_key),
            unproven=exc.response.status_code >= 500,
        )
    except Exception as exc:  # noqa: BLE001 - the caller reports this; it is not a crash
        return CompletionProbe(detail=f"{type(exc).__name__} from {url}", unproven=True)
    return CompletionProbe()


async def fetch_models(*, force: bool = False) -> tuple[list[ModelInfo], str]:
    """List the models the active endpoint offers, and where the list came from.

    Read live so the picker shows what this key can actually reach, cached briefly, and backed
    by a short static list so the UI still works when the endpoint is unreachable. The gateway's
    entries carry no context length, which is why ``ORBITAL_CONTEXT_WINDOW`` is configured.
    """
    global _model_cache
    target = active_endpoint()
    now = time.monotonic()
    if (
        target is not None
        and not force
        and _model_cache is not None
        and now - _model_cache[0] < MODEL_CACHE_TTL_SECONDS
        and _model_cache[3] == _cache_key(target)
    ):
        return list(_model_cache[1]), _model_cache[2]

    def fallback(reason: str) -> tuple[list[ModelInfo], str]:
        _log.info("using the fallback model list: %s", reason)
        return [ModelInfo(id=name, owned_by=None) for name in FALLBACK_MODELS], "fallback"

    if target is None:
        return fallback("no API key configured")

    # Authenticated, so its outcome is the cheapest evidence available about whether the key
    # works — and it is asked for anyway when the picker opens.
    probe = await probe_models(target)
    if probe.detail is not None:
        if probe.rejected:
            note_credential("rejected", probe.detail)
        return fallback(probe.detail)

    models = list(probe.models)
    if not models:
        return fallback("the gateway returned no model ids")

    _model_cache = (now, tuple(models), "gateway", _cache_key(target))
    note_credential("ok")
    return list(models), "gateway"
