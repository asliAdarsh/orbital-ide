"""Health, phase catalogue, configuration and native-dialog endpoints."""

from __future__ import annotations

import time

from fastapi import APIRouter

from orbital_backend import config
from orbital_backend.agents.llm import credential_status, fetch_models, note_credential
from orbital_backend.config import env_file_path
from orbital_backend.errors import CommandError, ToolError, logger
from orbital_backend.models import (
    CAPABILITIES,
    PHASE_SPECS,
    CapabilitiesResponse,
    ConfigResponse,
    ConfigUpdateRequest,
    ConfigUpdateResponse,
    HealthResponse,
    ModelsResponse,
    PhasesResponse,
    PickFolderRequest,
    PickFolderResponse,
)
from orbital_backend.services.folder_picker import choose_folder
from orbital_backend.services.settings_file import write_env_values
from orbital_backend.services.workspace import find_missing_binaries

_log = logger(__name__)

router = APIRouter(prefix="/api", tags=["system"])

_STARTED = time.monotonic()


@router.get("/health")
async def health() -> HealthResponse:
    """What the backend can say about itself right now."""
    settings = config.settings
    state, detail = credential_status()
    return HealthResponse(
        model=settings.llm_model,
        llm_configured=settings.llm_configured,
        llm_credential=state,
        llm_credential_detail=detail,
        missing_binaries=find_missing_binaries(),
        uptime_seconds=int(time.monotonic() - _STARTED),
    )


@router.get("/phases")
async def list_phases() -> PhasesResponse:
    return PhasesResponse(phases=list(PHASE_SPECS))


@router.get("/capabilities")
async def list_capabilities() -> CapabilitiesResponse:
    """What an agent may be allowed to do. The composer renders this list and hardcodes nothing."""
    return CapabilitiesResponse(capabilities=list(CAPABILITIES))


@router.get("/config")
async def read_config() -> ConfigResponse:
    return _config_response()


#: Settings the settings page may change: request field → (settings attribute, environment key).
#: The names genuinely differ — the wire calls it ``model``, pydantic calls it ``llm_model`` — and
#: conflating them silently set the wrong attribute. ``apiKey`` is deliberately not here: a
#: credential has one home, the provider profile it was entered for, and this endpoint refuses it
#: rather than writing into the file the profile store replaced.
_SETTING_FIELDS: dict[str, tuple[str, str]] = {
    "model": ("llm_model", "ORBITAL_LLM_MODEL"),
    "base_url": ("llm_base_url", "ORBITAL_LLM_BASE_URL"),
    "command_timeout": ("command_timeout", "ORBITAL_COMMAND_TIMEOUT"),
    "max_output_bytes": ("max_output_bytes", "ORBITAL_MAX_OUTPUT_BYTES"),
    "context_window": ("context_window", "ORBITAL_CONTEXT_WINDOW"),
    "max_tokens": ("llm_max_tokens", "ORBITAL_LLM_MAX_TOKENS"),
    "allowed_roots": ("allowed_roots", "ORBITAL_ALLOWED_ROOTS"),
}


def _config_response() -> ConfigResponse:
    settings = config.settings
    return ConfigResponse(
        model=settings.llm_model,
        base_url=settings.llm_base_url,
        api_key_configured=settings.llm_configured,
        command_timeout=settings.command_timeout,
        max_output_bytes=settings.max_output_bytes,
        allowed_roots=list(settings.allowed_roots),
        context_window=settings.context_window,
        max_tokens=settings.llm_max_tokens,
    )


@router.put("/config")
async def update_config(body: ConfigUpdateRequest) -> ConfigUpdateResponse:
    """Persist changed settings and apply them to the running process.

    Values are written to ``backend/.env`` and set on the live settings object, so everything
    except the bind address takes effect on the next run without a restart.

    An ``apiKey`` here is refused rather than written: the credential belongs to the provider
    profile it was entered for, and a client that still sends one has to be told that rather than
    left believing it was saved. ``ORBITAL_LLM_API_KEY`` remains the fallback for a machine with
    no profiles, and is edited in ``.env`` — not through this endpoint.
    """
    if body.api_key is not None:
        raise ToolError(
            "the API key belongs to a provider profile, not to the settings file: add or edit it "
            "under Providers (POST/PATCH /api/providers). PUT /api/config no longer accepts "
            "'apiKey'."
        )
    settings = config.settings
    updates: dict[str, object] = {}
    env_writes: dict[str, str] = {}
    for field, (attribute, env_key) in _SETTING_FIELDS.items():
        value = getattr(body, field)
        if value is None:
            continue
        updates[attribute] = value
        env_writes[env_key] = _render_env_value(value)

    changed = [
        field
        for field, (attribute, _env) in _SETTING_FIELDS.items()
        if attribute in updates and getattr(settings, attribute) != updates[attribute]
    ]

    if changed:
        try:
            written = write_env_values(env_file_path(), env_writes)
        except OSError as exc:
            raise CommandError(f"could not write backend/.env: {exc}") from exc
        for attribute, value in updates.items():
            setattr(settings, attribute, value)
        if "llm_base_url" in updates:
            # The refusal was about the endpoint that was just replaced; keeping it would refuse
            # the next run for a mistake the user has already fixed.
            note_credential("unknown")
        _log.info(
            "settings updated: %s (env keys written: %s)",
            ", ".join(changed),
            ", ".join(written) or "none",
        )

    return ConfigUpdateResponse(config=_config_response(), changed=changed)


def _render_env_value(value: object) -> str:
    """Render a python value the way the dotenv parser expects to read it back."""
    if isinstance(value, list):
        return ",".join(str(item) for item in value)
    return str(value)


@router.get("/models")
async def list_models() -> ModelsResponse:
    """The models the gateway offers.

    Fetched live so the picker reflects what the key can actually reach, with a small fallback
    so the UI still works when the gateway is unreachable or the key is missing.
    """
    models, source = await fetch_models()
    return ModelsResponse(models=models, default=config.settings.llm_model, source=source)


@router.post("/system/pick-folder")
async def pick_folder(body: PickFolderRequest | None = None) -> PickFolderResponse:
    """Show the OS folder chooser and return the absolute path the user selected.

    Only the browser build needs this — the desktop build asks Tauri for the folder. Web
    APIs cannot return an absolute path, so the local runtime provides the dialog.
    """
    request = body or PickFolderRequest()
    result = await choose_folder(request.title, request.initial_dir)
    return PickFolderResponse(path=result.path, available=result.available, reason=result.reason)
