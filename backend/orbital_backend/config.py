"""Runtime configuration for the Orbital backend sidecar.

Every field is overridable through an ``ORBITAL_``-prefixed environment variable or ``backend/.env``
(see ``backend/.env.example``). The file is located relative to this module rather than the working
directory, because the backend is started from two different places — ``tauri dev`` runs it with
``cwd=backend/`` while ``npm run backend:dev`` runs it from the repository root — and both must read
the same configuration.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Annotated

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

#: ``backend/.env`` — beside this package, so the backend owns its own configuration and the
#: repository root stays free of it. In a frozen sidecar this path does not exist and
#: configuration comes from the host process environment.
_ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


def env_file_path() -> Path:
    """The dotenv file this process reads — and the one the settings page writes."""
    return _ENV_FILE


def default_state_dir() -> Path:
    """The per-user directory for state that outlives a run, when ``ORBITAL_STATE_DIR`` is unset.

    Follows each platform's convention rather than writing beside the checkout: a packaged build
    is installed read-only, and its working directory is wherever the launcher happened to start.
    """
    if sys.platform == "win32":
        app_data = os.environ.get("APPDATA")
        base = Path(app_data) if app_data else Path.home() / "AppData" / "Roaming"
        return base / "Orbital"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Orbital"
    data_home = os.environ.get("XDG_DATA_HOME")
    base = Path(data_home) if data_home else Path.home() / ".local" / "share"
    return base / "orbital"


def state_dir() -> Path:
    """Where the backend keeps its own state. The setting wins when it is set at all."""
    override = settings.state_dir
    return default_state_dir() if override is None else override.expanduser()


def projects_file() -> Path:
    """The project registry: one JSON file under :func:`state_dir`."""
    return state_dir() / "projects.json"


class Settings(BaseSettings):
    """Resolved process configuration."""

    model_config = SettingsConfigDict(
        env_prefix="ORBITAL_",
        env_file=_ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    host: str = "127.0.0.1"
    port: int = 8765
    log_level: str = "info"
    llm_model: str = "deepseek-v4-flash"
    # OpenCode Go gateway. Zen (pay-as-you-go) is https://opencode.ai/zen/v1.
    # The prefix must end at /v1: the OpenAI client appends /chat/completions itself, so
    # https://opencode.ai/zen/go alone would request .../zen/go/chat/completions and 404.
    llm_base_url: str = "https://opencode.ai/zen/go/v1"
    llm_api_key: str = ""
    #: The shared secret every request and socket has to carry; see
    #: :mod:`orbital_backend.auth`. The host sets it — ``dev.mjs`` mints one, the Tauri sidecar
    #: reads the one this process mints when the variable is empty. ``repr=False`` so a traceback
    #: or a log of the settings object can never print it.
    auth_token: str = Field(default="", repr=False)
    #: Output ceiling for one specialist turn. Bounds a runaway generation; 0 disables it.
    llm_max_tokens: int = 8000
    #: Context window of the configured model, in tokens. Drives the context gauge; the
    #: gateway does not publish one, so this is configured rather than discovered.
    context_window: int = 128000
    command_timeout: int = 600
    max_output_bytes: int = 262144
    # ``NoDecode`` keeps pydantic-settings from demanding a JSON array: the Tauri host
    # sends one, while ``.env`` files use the comma-separated form.
    allowed_roots: Annotated[list[str], NoDecode] = Field(default_factory=list)
    #: State the backend owns rather than the project's: today the project registry. Unset means
    #: the per-user data directory; see :func:`default_state_dir`.
    state_dir: Path | None = None

    @field_validator("state_dir", mode="before")
    @classmethod
    def _blank_state_dir_is_unset(cls, value: object) -> object:
        # ``ORBITAL_STATE_DIR=`` — the documented spelling for "use the default" — arrives as an
        # empty string, which pydantic would read as ``Path(".")``: the working directory.
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("allowed_roots", mode="before")
    @classmethod
    def _split_allowed_roots(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        text = value.strip()
        if not text:
            return []
        if text.startswith("["):
            try:
                decoded = json.loads(text)
            except ValueError:
                decoded = None
            if isinstance(decoded, list):
                return [str(entry).strip() for entry in decoded if str(entry).strip()]
        return [part.strip() for part in text.split(",") if part.strip()]

    @property
    def llm_configured(self) -> bool:
        """True when a run has a credential to start with.

        The active provider profile decides whenever there is one, because the active profile is
        what :func:`orbital_backend.agents.llm.build_llm` will talk to: a `local` profile needs no
        key, and any other needs its own. With no profile this is the dotenv key, exactly as it
        was before profiles existed, so a fresh clone and the health endpoint behave as before.

        The profile store is imported here rather than at module scope because the store reads this
        module for the state directory: the import runs one way, and this is the single question
        that has to be answered from both sides — one answer, so the settings page, the health
        check and the run itself cannot disagree about whether a run can start.
        """
        from orbital_backend.services.providers import credential_configured

        return credential_configured()


settings = Settings()


def reload_settings() -> Settings:
    """Rebuild :data:`settings` from the environment and rebind the module global."""
    global settings
    settings = Settings()
    return settings
