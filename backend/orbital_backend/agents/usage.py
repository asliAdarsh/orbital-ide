"""Usage accounting, measured locally rather than reported by the gateway.

The provider's own token counts proved unreliable here — one run reported roughly nine million
input tokens for a single call — so nothing in the running-cost readout depends on them.

LangChain's callback interface is the hook: ``on_chat_model_start`` receives the exact message
list that is about to be sent (which is why it is the honest place to measure context
pressure) and ``on_llm_end`` receives the response. Everything below is therefore a count of
what Orbital really sent and received, not an estimate of what a provider said.
"""

from __future__ import annotations

from typing import Any

from langchain_core.callbacks import AsyncCallbackHandler

#: Rough characters per token for English prose and source code. A gauge cannot be more precise
#: than this without a tokenizer, and the figure it produces is honest about being approximate.
CHARS_PER_TOKEN = 4


def estimate_tokens(chars: int) -> int:
    """Approximate a token count from a character count."""
    return chars // CHARS_PER_TOKEN


def text_size(value: Any) -> int:
    """Characters in a message, a batch of messages, a prompt list or a model response."""
    if value is None:
        return 0
    if isinstance(value, str):
        return len(value)
    if isinstance(value, (list, tuple)):
        return sum(text_size(item) for item in value)
    # ChatMessage / Generation / str-like objects.
    text = getattr(value, "text", None)
    if isinstance(text, str):
        return len(text)
    for attribute in ("content", "message", "generations", "values"):
        nested = getattr(value, attribute, None)
        if nested is not None:
            return text_size(nested)
    if isinstance(value, dict):
        return sum(text_size(item) for item in value.values())
    return 0


class UsageRecorder(AsyncCallbackHandler):
    """Accumulates one run's prompt and completion volume from LangChain callbacks.

    The graph runs asynchronously, so the async callback methods are the ones that fire; the
    synchronous variants would never be called.
    """

    def __init__(self) -> None:
        super().__init__()
        self.model_calls = 0
        self.prompt_chars = 0
        self.completion_chars = 0
        #: Largest single prompt seen — the context-window high-water mark.
        self.peak_prompt_chars = 0

    def _count_prompt(self, value: Any) -> None:
        chars = text_size(value)
        self.model_calls += 1
        self.prompt_chars += chars
        self.peak_prompt_chars = max(self.peak_prompt_chars, chars)

    async def on_chat_model_start(
        self, serialized: dict[str, Any], messages: Any, **kwargs: Any
    ) -> None:
        self._count_prompt(messages)

    async def on_llm_start(
        self, serialized: dict[str, Any], prompts: list[str], **kwargs: Any
    ) -> None:
        self._count_prompt(prompts)

    async def on_llm_end(self, response: Any, **kwargs: Any) -> None:
        self.completion_chars += text_size(response)
