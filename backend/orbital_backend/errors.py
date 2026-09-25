"""Error taxonomy, logging factory and FastAPI exception wiring."""

from __future__ import annotations

import json
import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

LOGGER_NAMESPACE = "orbital_backend"


def logger(name: str) -> logging.Logger:
    """Return a logger inside the ``orbital_backend`` namespace (stdlib logging only)."""
    return logging.getLogger(
        name if name.startswith(LOGGER_NAMESPACE) else f"{LOGGER_NAMESPACE}.{name}"
    )


def provider_message(body: str) -> str | None:
    """The message out of a provider's JSON error envelope, when the body carries one.

    OpenAI-compatible gateways answer a refusal with ``{"error": {"message": …}}``. Anything
    else — a proxy's HTML page, a bare status line — is left alone, so callers can fall back to
    their own reading of the body instead of being handed a guess.
    """
    try:
        payload: object = json.loads(body.strip())
    except (ValueError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    candidates = (
        error.get("message") if isinstance(error, dict) else error,
        payload.get("detail"),
        payload.get("message"),
    )
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return " ".join(candidate.split())
    return None


class OrbitalError(Exception):
    """Base class for every failure the API renders as ``{"detail": <message>}``."""

    status_code: int = 500

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class WorkspaceError(OrbitalError):
    """A path escaped the project root, the root is missing, or no project is open."""

    status_code = 400


class NotFoundError(OrbitalError):
    """A requested file or resource does not exist."""

    status_code = 404


class ToolError(OrbitalError):
    """A tool refused the request (bad arguments, unwritable target)."""

    status_code = 400


class CommandError(OrbitalError):
    """A command could not be executed at all."""

    status_code = 500


class LLMNotConfigured(OrbitalError):
    """An agent run was requested while ``ORBITAL_LLM_API_KEY`` is unset."""

    status_code = 503



def install_error_handlers(app: FastAPI) -> None:
    """Render failures as JSON so clients can always parse ``detail``."""

    @app.exception_handler(OrbitalError)
    async def _orbital_error(_: Request, exc: OrbitalError) -> JSONResponse:
        if exc.status_code >= 500:
            logger(__name__).error("request failed: %s", exc.detail)
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, exc: Exception) -> JSONResponse:
        # A plain-text 500 would break the client's ApiError contract; log the traceback
        # and answer with a parseable body instead.
        logger(__name__).error("unhandled error", exc_info=exc)
        return JSONResponse(status_code=500, content={"detail": "internal server error"})
