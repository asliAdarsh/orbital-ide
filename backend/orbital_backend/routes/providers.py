"""Provider profile endpoints: which endpoint a run talks to, and whether it answers.

The stored profile never leaves the backend whole — :class:`ProviderProfileInfo` has no field a
key could travel in — and every mutation returns the whole list, so the client redraws from one
shape instead of reconciling four.
"""

from __future__ import annotations

from collections.abc import Sequence

from fastapi import APIRouter

from orbital_backend.agents.llm import (
    ModelsProbe,
    describes_active_credential,
    endpoint_for,
    note_credential,
    probe_completion,
    probe_models,
)
from orbital_backend.models import (
    PROVIDER_PRESETS,
    CreateProviderRequest,
    ProviderConnectResponse,
    ProviderModelsResponse,
    ProviderPresetsResponse,
    ProviderProfile,
    ProviderTestResponse,
    ProvidersResponse,
    UpdateProviderRequest,
)
from orbital_backend.services.providers import (
    KEY_MOVED_NOTICE,
    preset_for,
    providers,
)

router = APIRouter(prefix="/api", tags=["providers"])


async def _probe(profile: ProviderProfile) -> ModelsProbe:
    """One authenticated call to a profile's endpoint, recording what it says about the key.

    The verdict is only recorded for the profile a *default* run would talk to: a probe of a
    profile the user has not activated is evidence about that profile, and the settings row and
    ``/api/health`` both claim to speak for the active one.
    """
    probe = await probe_models(endpoint_for(profile))
    if describes_active_credential(profile):
        if probe.rejected:
            note_credential("rejected", probe.detail)
        elif probe.detail is None:
            note_credential("ok")
    return probe


def _response(profiles: Sequence[ProviderProfile], notice: str | None = None) -> ProvidersResponse:
    """The list as the wire carries it, with the active id read off the profiles themselves.

    One source of truth — the ``active`` flag on each profile — so the two cannot disagree about
    which profile a run would use. ``notice`` is how an edit that succeeded still has something to
    say, and it is ``None`` unless there is.
    """
    return ProvidersResponse(
        profiles=[profile.info() for profile in profiles],
        active_id=next((profile.id for profile in profiles if profile.active), None),
        notice=notice,
    )


@router.get("/providers")
async def list_providers() -> ProvidersResponse:
    """Every configured endpoint. The key itself is never in this payload."""
    return _response(providers.list())


@router.get("/providers/presets")
async def list_presets() -> ProviderPresetsResponse:
    """The providers a profile can be created from, so the form hardcodes nothing."""
    return ProviderPresetsResponse(presets=list(PROVIDER_PRESETS))


@router.post("/providers")
async def create_provider(body: CreateProviderRequest) -> ProvidersResponse:
    """Add a profile. The first one becomes active; see :meth:`ProviderRegistry.create`."""
    return _response(
        providers.create(
            label=body.label,
            kind=body.kind,
            base_url=body.base_url,
            model=body.model,
            api_key=body.api_key,
        )
    )


@router.patch("/providers/{profile_id}")
async def update_provider(profile_id: str, body: UpdateProviderRequest) -> ProvidersResponse:
    """Edit a profile. ``None`` leaves a field alone; an empty ``apiKey`` clears the key.

    Moving a profile that holds a key to a different host is allowed — re-pointing an endpoint is
    a normal edit — but never quietly: the key was entered for the old host, and the response says
    so, so the UI can tell the user where their credential is about to be sent.
    """
    before = providers.find(profile_id)
    profiles = providers.update(
        profile_id,
        label=body.label,
        base_url=body.base_url,
        model=body.model,
        api_key=body.api_key,
    )
    notice = None
    if body.base_url is not None:
        after = next(profile for profile in profiles if profile.id == profile_id)
        if after.base_url != before.base_url and before.api_key:
            notice = KEY_MOVED_NOTICE.format(
                label=after.label, before=before.base_url, after=after.base_url
            )
    return _response(profiles, notice)


@router.delete("/providers/{profile_id}")
async def delete_provider(profile_id: str) -> ProvidersResponse:
    """Forget a profile, moving the active badge to another one when it held it."""
    return _response(providers.delete(profile_id))


@router.post("/providers/{profile_id}/activate")
async def activate_provider(profile_id: str) -> ProvidersResponse:
    """Make this the profile every run talks to."""
    return _response(providers.activate(profile_id))


@router.post("/providers/{profile_id}/connect")
async def connect_provider(profile_id: str) -> ProviderConnectResponse:
    """Ask the profile's endpoint what it serves, store the answer, and say where it came from.

    This is the step that turns a pasted URL and key into a list to choose from, and every outcome
    comes back as 200 because every outcome is one of the answers: a key the provider refuses, and
    a provider that will not list its models, are both things the user has to act on rather than
    transport errors.

    Three things can happen to the model list, and they are deliberately told apart:

    * the endpoint answers with a model list — it is stored, and ``source`` is ``"provider"``;
    * it refuses the credential — nothing is stored and ``ok`` is false, with the endpoint's own
      words, because a list would be a claim about what this key can reach;
    * anything else — no ``/models`` path, unreachable, a malformed body — is **not** evidence
      about the key, so the preset's curated list is stored instead and ``ok`` stays true. A
      provider with nothing curated reports ``ok`` false and says to type a model by hand.

    An endpoint that answers 2xx with nothing in the list is a working key that will not say what
    it serves: the credential verdict it records is ``ok``, while the list itself falls back the
    same way any other silence does.

    A list, though, only proves the endpoint will *talk* to the account, so once it is stored the
    connect spends one more request on the profile's own model asking for a single token (see
    :func:`~orbital_backend.agents.llm.probe_completion`; a prompt's worth of usage per connect, and
    the cheapest way to hear "this account cannot run" now rather than at the first prompt). If the
    account is refused, ``ok`` goes false with the endpoint's own words while the list **stays
    stored** — what the endpoint serves is true regardless of who may use it, and ``source`` keeps
    saying where the list came from.
    """
    profile = providers.find(profile_id)
    probe = await _probe(profile)

    if probe.detail is None and probe.models:
        models = [info.id for info in probe.models]
        providers.store_models(profile_id, models, "provider")
        detail = f"{len(models)} models from {profile.base_url}"
        run = await probe_completion(endpoint_for(profile))
        if run.detail is None:
            return ProviderConnectResponse(ok=True, detail=detail, models=models, source="provider")
        if run.unproven:
            # Nothing was proved either way, and the list was. Saying the account cannot run here
            # would be inventing a verdict out of a timeout or a dropped connection.
            return ProviderConnectResponse(
                ok=True,
                detail=f"{detail}; whether it can run is unknown: {run.detail}",
                models=models,
                source="provider",
            )
        return ProviderConnectResponse(
            ok=False, detail=run.detail, models=models, source="provider"
        )

    if probe.rejected:
        # Nothing stored, and nothing *cleared* either: whatever an earlier connect listed is still
        # what this endpoint answers for, and one refused key is no evidence that has changed.
        return ProviderConnectResponse(
            ok=False, detail=probe.detail or "", models=[], source="preset"
        )

    preset = preset_for(profile)
    if preset is not None and preset.fallback_models:
        models = list(preset.fallback_models)
        providers.store_models(profile_id, models, "preset")
        return ProviderConnectResponse(
            ok=True,
            detail=(
                f"the provider did not serve a model list ({probe.detail or 'it returned no ids'}); "
                f"showing the curated {preset.label} list"
            ),
            models=models,
            source="preset",
        )

    return ProviderConnectResponse(
        ok=False,
        detail=(
            f"the provider did not serve a model list ({probe.detail or 'it returned no ids'}) "
            "and this provider has no curated list to fall back on: enter a model id by hand"
        ),
        models=[],
        source="preset",
    )


@router.get("/providers/{profile_id}/models")
async def list_provider_models(profile_id: str) -> ProviderModelsResponse:
    """What this profile has stored, read from the store — deliberately without a network call.

    A dropdown opening is not a reason to make the provider answer: it already answered, the answer
    is stored, and a provider that is slow, throttling or off must not be able to empty a list the
    user can still pick from. ``POST .../connect`` is what re-asks.
    """
    profile = providers.find(profile_id)
    return ProviderModelsResponse(
        models=list(profile.models),
        source=profile.models_source,
        fetched_at=profile.models_fetched_at,
    )


@router.post("/providers/{profile_id}/test")
async def test_provider(profile_id: str) -> ProviderTestResponse:
    """One authenticated call to the profile's endpoint: is it reachable with this key?

    A refused key is the answer, not an error: the endpoint's own words come back with ``ok``
    false and the request still succeeds, because "your key was rejected" is exactly what the
    user asked to find out. Unlike ``connect`` this stores nothing — it is the settings row's
    question about the credential, not the picker's question about the catalogue.
    """
    profile = providers.find(profile_id)
    probe = await _probe(profile)
    if probe.detail is not None:
        return ProviderTestResponse(ok=False, detail=probe.detail, models=[])
    return ProviderTestResponse(
        ok=True,
        detail=f"{len(probe.models)} models from {profile.base_url}",
        models=[info.id for info in probe.models],
    )
