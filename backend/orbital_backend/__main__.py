"""``python -m orbital_backend`` — run the sidecar with uvicorn."""

from __future__ import annotations

import socket

import uvicorn

from orbital_backend.config import settings
from orbital_backend.main import app


class _SidecarServer(uvicorn.Server):
    """Prints the handshake line the Rust host blocks on, once the port is bound."""

    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        await super().startup(sockets)
        print(f"ORBITAL_BACKEND_READY port={self._bound_port()}", flush=True)

    def _bound_port(self) -> int:
        for listener in self.servers:
            for sock in listener.sockets or ():
                return sock.getsockname()[1]
        return settings.port


def main() -> None:
    config = uvicorn.Config(
        app, host=settings.host, port=settings.port, log_level=settings.log_level
    )
    _SidecarServer(config).run()


if __name__ == "__main__":
    main()
