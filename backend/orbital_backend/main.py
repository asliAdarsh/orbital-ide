"""FastAPI application factory, lifespan wiring and sidecar entry point."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from orbital_backend import config, ws
from orbital_backend.auth import (
    MINTED_TOKEN_WARNING,
    ORIGIN_REGEX,
    configured_token,
    require_token,
)
from orbital_backend.errors import install_error_handlers, logger
from orbital_backend.events import bus
from orbital_backend.models import BACKEND_VERSION
from orbital_backend.routes import all_routers
from orbital_backend.services.providers import providers
from orbital_backend.services.sessions import sessions
from orbital_backend.services.watcher import watchers

_log = logger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = config.settings
    logging.basicConfig(
        level=logging.getLevelNamesMapping().get(settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    bus.bind(asyncio.get_running_loop())
    # An installation that predates provider profiles has its credential in `.env`; this turns it
    # into an active profile once, before the first request can read an empty list. It is a no-op
    # on every later start, and it never raises — a store the backend cannot seed is not a reason
    # to refuse to start.
    providers.migrate_from_env()
    if not configured_token():
        # Once, at startup, and loudly: without a configured token this process mints one that
        # only its readiness line knows, so nothing can talk to it until that token is passed on.
        _log.warning(MINTED_TOKEN_WARNING)
    _log.info(
        "orbital backend starting port=%s model=%s base_url=%s llm_configured=%s allowed_roots=%s",
        settings.port,
        settings.llm_model,
        settings.llm_base_url,
        settings.llm_configured,
        settings.allowed_roots,
    )
    # The Rust host blocks on the ORBITAL_BACKEND_READY line, which __main__ prints
    # once uvicorn has actually bound the port.
    try:
        yield
    finally:
        # A run can be mid-flight when the host asks the process to stop, and a transcript that
        # only ever lived in memory is the conversation the user just watched go by. Written before
        # the watchers stop, so nothing else is competing for the store while it is written.
        sessions.persist_all()
        await watchers.stop_all()


def create_app() -> FastAPI:
    """Build the ASGI application: authentication, CORS, routers, error handlers.

    The token dependency is added with each API router rather than on the application, so a route
    added to a router is behind it without anyone remembering to add it — and so the socket is not
    behind it: an application-level dependency is run for a WebSocket too, which would refuse the
    handshake before the token in the socket's first frame could ever arrive; see
    :func:`orbital_backend.ws.websocket_endpoint`.
    """
    app = FastAPI(title="Orbital Backend", version=BACKEND_VERSION, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=ORIGIN_REGEX,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    for router in all_routers:
        app.include_router(router, dependencies=[Depends(require_token)])
    app.include_router(ws.router)
    install_error_handlers(app)
    return app


app = create_app()
