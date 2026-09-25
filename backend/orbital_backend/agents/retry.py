"""Classification of transient provider failures.

A response stream that dies mid-flight — a reset connection, a TLS teardown, a 502 from the
gateway — is a normal event during a long agent run: the work is not wrong, the socket went
away. LangGraph retries the node (see the retry policies in :mod:`orbital_backend.agents.graph`)
and anything that persists is reported as one short line.

Matching is by exception *name* and HTTP status rather than by importing transport classes,
so switching HTTP client cannot silently disable retries. ``openai``'s own ``max_retries``
does not help here: it only wraps the initial request, not a stream that fails after the
first chunk has already been consumed.
"""

from __future__ import annotations

from collections.abc import Iterator

#: Exception class names that mean "the transport gave up", across httpx, httpcore, anyio,
#: openai and asyncio.
_TRANSIENT_NAMES = frozenset(
    {
        "APIConnectionError",
        "APITimeoutError",
        "BrokenResourceError",
        "ClosedResourceError",
        "ConnectError",
        "ConnectTimeout",
        "ConnectionAbortedError",
        "ConnectionResetError",
        "IncompleteReadError",
        "InternalServerError",
        "NetworkError",
        "PoolTimeout",
        "ProtocolError",
        "ReadError",
        "ReadTimeout",
        "RemoteProtocolError",
        "ServiceUnavailableError",
        "Timeout",
        "TimeoutError",
        "WriteError",
    }
)

#: Statuses worth another attempt: throttling, conflicts and gateway/server faults.
_TRANSIENT_STATUS = frozenset({408, 409, 425, 429, 500, 502, 503, 504})

#: Statuses that mean the request was understood and refused on the key's account. Retrying
#: these is pointless — the key has to change — and the distinction matters because the app can
#: refuse the next attempt itself instead of spending a turn to rediscover it.
_AUTH_STATUS = frozenset({401, 403})

#: Exception names that carry that meaning without a usable status code.
_AUTH_NAMES = frozenset({"AuthenticationError", "PermissionDeniedError"})

TRANSIENT_HINT = (
    "the connection to the gateway dropped mid-response; retrying the phase usually clears it"
)


def _chain(exc: BaseException) -> Iterator[BaseException]:
    """Yield an exception and every exception it wraps, without looping on cycles."""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def is_transient(exc: BaseException) -> bool:
    """Whether ``exc`` — or anything it wraps — looks like a retryable transport failure."""
    for item in _chain(exc):
        if type(item).__name__ in _TRANSIENT_NAMES:
            return True
        status = getattr(item, "status_code", None)
        if isinstance(status, int) and status in _TRANSIENT_STATUS:
            return True
    return False


def is_credential_failure(exc: BaseException) -> bool:
    """Whether ``exc`` means the gateway refused the key rather than being unreachable.

    An unreachable gateway is worth retrying; a refused key is not, and the difference is what
    lets the next attempt be refused locally with an explanation instead of failing again
    somewhere in the middle of a turn.
    """
    for item in _chain(exc):
        if type(item).__name__ in _AUTH_NAMES:
            return True
        status = getattr(item, "status_code", None)
        if isinstance(status, int) and status in _AUTH_STATUS:
            return True
        response = getattr(item, "response", None)
        if getattr(response, "status_code", None) in _AUTH_STATUS:
            return True
    return False
