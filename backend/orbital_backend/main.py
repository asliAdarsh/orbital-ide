"""FastAPI application factory, lifespan wiring and sidecar entry point."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from orbital_backend import config, ws
from orbital_backend.errors import install_error_handlers, logger
from orbital_backend.events import bus
from orbital_backend.models import BACKEND_VERSION
from orbital_backend.routes import all_routers
from orbital_backend.services.watcher import watchers

_log = logger(__name__)

#: CORS origins.
#:
#: A fixed port list only breaks local tooling (`vite preview`, a second dev server, a
#: different port because 5173 was taken) without adding protection: the server binds
#: 127.0.0.1, so there is no remote origin that CORS could be defending against. The Tauri
#: webview origins are listed explicitly because they are not loopback URLs. Anything else
#: is still rejected.
ORIGIN_REGEX = (
    r"^(https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?|tauri://localhost|http://tauri\.localhost)$"
)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = config.settings
    logging.basicConfig(
        level=logging.getLevelNamesMapping().get(settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    bus.bind(asyncio.get_running_loop())
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
        await watchers.stop_all()


def create_app() -> FastAPI:
    """Build the ASGI application: CORS, routers, error handlers."""
    app = FastAPI(title="Orbital Backend", version=BACKEND_VERSION, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=ORIGIN_REGEX,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    for router in all_routers:
        app.include_router(router)
    app.include_router(ws.router)
    install_error_handlers(app)
    return app


app = create_app()
