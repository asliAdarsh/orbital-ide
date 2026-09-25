"""The web tool: read a documentation page as text.

The agent plans against libraries it cannot see, and a wrong guess about an API is paid for in the
build phase. One GET, no crawling, no search engine: the model names the URL — usually one the user
gave it or one it knows from training — and gets the page back as readable text.
"""

from __future__ import annotations

import re
from html import unescape
from typing import Annotated
from urllib.parse import urlparse

import httpx
from langchain_core.tools import BaseTool, InjectedToolCallId, tool

from .context import ToolContext, run_tool, tool_args

#: One fetch, one timeout. A documentation page that has not answered in fifteen seconds is not
#: going to be worth the turn.
FETCH_TIMEOUT_SECONDS = 15.0

#: Ceiling on what one page may cost. Read off the wire rather than off a decoded string, so an
#: endless stream cannot exhaust memory before it is measured.
MAX_RESPONSE_BYTES = 512 * 1024

#: Ceiling on the text handed to the model. The output is replayed on every later turn of the run,
#: so a whole reference manual is charged for again and again — the head of a page is what is read.
MAX_TEXT_CHARS = 8_000

#: Schemes this tool will open. Anything else — ``file:``, ``ftp:``, ``data:`` — is a request to
#: reach past the network, which is not what the tool is for and not what the user agreed to.
ALLOWED_SCHEMES = frozenset({"http", "https"})

#: Content types that reduce to text. Anything else (a PDF, an image, a zip) would be handed to the
#: model as mojibake, so it is refused with a line that says so instead.
TEXT_CONTENT_TYPES = ("text/", "application/json", "application/xml", "application/xhtml+xml")

#: Of those, the ones that are markup and so get their tags stripped. A JSON body may legitimately
#: contain ``<``, and running the tag regex over it would eat what the model came for.
MARKUP_CONTENT_TYPES = ("text/html", "application/xhtml+xml")

_SCRIPT_OR_STYLE = re.compile(r"<(script|style)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_MARKUP = re.compile(r"<[^>]*>")
_INLINE_SPACE = re.compile(r"[^\S\n]+")


def readable_text(body: str, *, markup: bool) -> str:
    """Reduce a fetched body to text worth reading: tags and scripts out, whitespace collapsed."""
    if markup:
        body = _SCRIPT_OR_STYLE.sub(" ", body)
        body = unescape(_MARKUP.sub(" ", body))
    lines = (_INLINE_SPACE.sub(" ", line).strip() for line in body.splitlines())
    return "\n".join(line for line in lines if line)


def _client() -> httpx.AsyncClient:
    """One client per fetch. A call is a one-shot request, so a pooled client would only hold a
    connection to a documentation site open for the rest of the run."""
    return httpx.AsyncClient(timeout=FETCH_TIMEOUT_SECONDS, follow_redirects=True)


def _is_text(content_type: str) -> bool:
    kind = content_type.split(";", 1)[0].strip().lower()
    return kind.startswith(TEXT_CONTENT_TYPES)


async def fetch(url: str) -> str:
    """Fetch one URL and return its readable text, or an ``ERROR:`` line saying why not."""
    parsed = urlparse(url)
    if parsed.scheme.lower() not in ALLOWED_SCHEMES:
        return (
            f"ERROR: fetch_url only reads http and https URLs "
            f"(got {parsed.scheme or 'no scheme'!r}): {url}"
        )

    try:
        async with _client() as client:
            async with client.stream("GET", url) as response:
                content_type = response.headers.get("content-type", "")
                if response.status_code >= 400:
                    return f"ERROR: {url} answered HTTP {response.status_code}."
                if not _is_text(content_type):
                    return (
                        f"ERROR: {url} served {content_type or 'an unknown content type'}, "
                        "which is not text. fetch_url reads text documents only."
                    )
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) >= MAX_RESPONSE_BYTES:
                        break
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        # InvalidURL is not an HTTPError: a malformed URL (``https://`` with no host) fails before
        # any connection is attempted, and it must read as a line, not as a crash.
        return f"ERROR: could not fetch {url}: {exc}"

    truncated = len(body) >= MAX_RESPONSE_BYTES
    text = readable_text(
        body.decode(response.charset_encoding or "utf-8", errors="replace"),
        markup=content_type.split(";", 1)[0].strip().lower() in MARKUP_CONTENT_TYPES,
    )
    if len(text) > MAX_TEXT_CHARS:
        text = f"{text[:MAX_TEXT_CHARS]}\n... [truncated, {len(text)} characters total]"
    note = f" (stopped reading at {MAX_RESPONSE_BYTES} bytes)" if truncated else ""
    return f"OK: GET {url} ({content_type}{note})\n\n{text}"


def web_tools(ctx: ToolContext) -> list[BaseTool]:
    """Build the web tool bound to one agent context."""

    @tool
    async def fetch_url(url: str, tool_call_id: Annotated[str, InjectedToolCallId] = "") -> str:
        """Read one web page as text — use it to read documentation for a library or API while planning."""
        return await run_tool(
            ctx, "fetch_url", tool_call_id, tool_args(url=url), lambda: fetch(url)
        )

    return [fetch_url]
