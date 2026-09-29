"""The shared token that makes the local runtime answer only its host.

The runtime binds ``127.0.0.1``, and loopback is not a boundary: any page the user has open can
reach a loopback port, and on a shared or managed machine so can every other local account. So
the host and the runtime share a secret, and every request and every socket has to carry it:

* ``dev.mjs`` mints one and passes it as ``ORBITAL_AUTH_TOKEN``, because it also has to hand the
  same value to the Vite dev server — neither side can read the other's stdout;
* the Tauri host spawns the sidecar without one, so the sidecar mints its own and prints it on
  the readiness line the host already parses for the port.

A run with neither — a bare ``python -m orbital_backend`` — mints a token that no client knows,
so it answers nobody until that token is passed on. That is deliberate: the runtime never serves
an unauthenticated request, whether or not a token was configured, and the startup line says how
to fix the bare case.
"""

from __future__ import annotations

import re
import secrets
import threading

from fastapi import Header, HTTPException, status

from orbital_backend import config

#: The variable a caller is told to look at when it is refused.
AUTH_TOKEN_ENV = "ORBITAL_AUTH_TOKEN"

#: Length of a minted token, before url-safe encoding. 32 bytes is the same order as a session
#: cookie and is unguessable; the encoding keeps it out of quoting trouble in a header, an env
#: file and a readiness line.
TOKEN_BYTES = 32

#: Origins an HTTP request or a socket handshake may come from. Everything served over loopback —
#: a fixed port list would only break local tooling such as `vite preview` or a second dev server
#: on another port without adding protection, because the server binds loopback — plus the Tauri
#: webview origins, which are not loopback URLs. Anything else is refused.
ORIGIN_REGEX = (
    r"^(https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?|tauri://localhost|http://tauri\.localhost)$"
)

#: The Tauri webview, in the spellings it has on the three platforms Tauri ships. The socket
#: handshake accepts all of them; only the two the CORS regex already carries are shared with it,
#: so widening this list cannot silently widen the HTTP policy.
TAURI_ORIGINS = ("tauri://localhost", "http://tauri.localhost", "https://tauri.localhost")

#: The 401 body. One constant whatever the state of the configuration, so a caller cannot learn
#: from a refusal whether a token is configured — and it names the variable, the reason, and the
#: development command rather than leaving the reader to guess.
UNAUTHENTICATED_DETAIL = (
    f"this runtime answers only callers that present its token: send it as "
    f"'Authorization: Bearer <{AUTH_TOKEN_ENV}>'. The token is the one on the backend's "
    "ORBITAL_BACKEND_READY line, which the desktop host reads and hands to the app. Orbital "
    "refuses unauthenticated callers by design — 127.0.0.1 is reachable by every local account "
    "and by any page the user has open. In development, start the backend with "
    f"'npm run backend:dev': it mints {AUTH_TOKEN_ENV} and gives the frontend the same value."
)

#: Logged once at startup when no token was configured, so the operator learns where the minted
#: one went instead of discovering a wall of 401s.
MINTED_TOKEN_WARNING = (
    f"no {AUTH_TOKEN_ENV} is configured: this run minted a token and printed it on its "
    "ORBITAL_BACKEND_READY line. Callers must send it as 'Authorization: Bearer <token>', so a "
    "bare 'python -m orbital_backend' now answers nobody. Run 'npm run backend:dev' instead — "
    "it mints the token, passes it to the backend and writes the same value to "
    "frontend/.env.local as VITE_ORBITAL_TOKEN for the Vite dev server — or export "
    f"{AUTH_TOKEN_ENV} yourself everywhere the runtime and its clients read it."
)

_minted: str | None = None
_mint_lock = threading.Lock()


def configured_token() -> str:
    """The token the environment (or ``backend/.env``) provides, or ``""`` when it provides none."""
    return config.settings.auth_token.strip()


def runtime_token() -> str:
    """The token this process accepts.

    A configured token wins: ``dev.mjs`` sets one so the frontend and the backend agree on it
    before either has started. With none, the runtime mints one on first use — which is the
    packaged case, where the host has no token of its own and reads this one off the readiness
    line. Minting rather than refusing to serve is what keeps the socket and every request
    authenticated in a build nobody configured by hand; a caller that has not been given the
    token is still refused.
    """
    configured = configured_token()
    if configured:
        return configured
    global _minted
    with _mint_lock:
        if _minted is None:
            _minted = secrets.token_urlsafe(TOKEN_BYTES)
        return _minted


def token_matches(candidate: str | None) -> bool:
    """Whether a presented token is this runtime's own. Constant-time, and empty never matches."""
    if not candidate:
        return False
    return secrets.compare_digest(candidate, runtime_token())


def bearer(header: str | None) -> str | None:
    """The token out of an ``Authorization: Bearer …`` header, or ``None`` when it is not one."""
    if not header:
        return None
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer":
        return None
    return value.strip() or None


def require_token(authorization: str | None = Header(default=None)) -> None:
    """FastAPI dependency that refuses every request that does not carry the token.

    Installed on the application, so a route added later is behind it without anyone remembering
    to add it — one gate, not one per router.
    """
    if not token_matches(bearer(authorization)):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=UNAUTHENTICATED_DETAIL)


def origin_allowed(origin: str | None) -> bool:
    """Whether a socket handshake may proceed.

    A missing ``Origin`` is allowed: a browser always sends one, so its absence means a
    non-browser local client, and the token — not the origin — is what gates the socket. The
    check is here because a browser does not apply CORS to a WebSocket handshake, so without it
    any page the user visits could open the socket and ask for a terminal.
    """
    if origin is None:
        return True
    return origin in TAURI_ORIGINS or re.fullmatch(ORIGIN_REGEX, origin) is not None
