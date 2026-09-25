"""The agent's working list, published to the UI as it works.

A phase can run for minutes across dozens of tool calls, and the token stream does not say what
the agent thinks it is doing. This tool is how it says so: the model decides the list, publishes
it whenever it changes, and the composer renders it beside the conversation.

Publishing goes through the event bus like every other agent action, so the list arrives as a
frame rather than as something the client has to reconstruct from tool traffic.
"""

from __future__ import annotations

from typing import Annotated

from langchain_core.tools import BaseTool, InjectedToolCallId, tool
from pydantic import BaseModel, Field

from ..models import TODO_STATUSES, TodoItem, TodosPayload
from .context import ToolContext, run_tool, tool_args

#: A list longer than this is not a working list any more. Refused rather than trimmed, so the
#: agent has to decide what actually matters instead of having the tail silently dropped.
MAX_TODO_ITEMS = 20


# ``status`` is a plain string rather than the wire union on purpose: a value outside the three
# allowed ones has to come back as an ``ERROR:`` line the agent can act on, and a schema rejection
# would never reach the tool body that writes it.
class TodoDraft(BaseModel):
    """One item of the working list: the step, and where it has got to."""

    content: str = Field(description="The step, in a few words.")
    status: str = Field(description="One of: pending, in_progress, completed.")


def todo_tools(ctx: ToolContext) -> list[BaseTool]:
    """Build the todo tool bound to one agent context."""

    async def publish(items: list[TodoDraft]) -> str:
        if len(items) > MAX_TODO_ITEMS:
            return (
                f"ERROR: {len(items)} items is more than the {MAX_TODO_ITEMS} a working list "
                "may hold; keep the steps that matter"
            )
        published: list[TodoItem] = []
        for index, item in enumerate(items, start=1):
            content = item.content.strip()
            if not content:
                return f"ERROR: item {index} has no content"
            if item.status not in TODO_STATUSES:
                return (
                    f"ERROR: item {index} has status {item.status!r}; expected one of "
                    f"{', '.join(TODO_STATUSES)}"
                )
            published.append(TodoItem(content=content, status=item.status))
        await ctx.bus.emit(
            "agent.todos", TodosPayload(items=published), session_id=ctx.session_id
        )
        return f"OK: published {len(published)} todo(s) to the user's list"

    @tool
    async def update_todos(
        items: list[TodoDraft],
        tool_call_id: Annotated[str, InjectedToolCallId] = "",
    ) -> str:
        """Publish your working list for this phase. Send the whole list every time — it replaces
        the previous one — with each item `pending`, `in_progress` or `completed`. Keep it current
        for multi-step work: mark the item you are on `in_progress` and mark each item `completed`
        as you finish it. At most 20 items."""
        return await run_tool(
            ctx,
            "update_todos",
            tool_call_id,
            tool_args(items=[item.model_dump() for item in items]),
            lambda: publish(items),
        )

    return [update_todos]
