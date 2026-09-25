"""LangChain tool layer for Orbital agents."""

from __future__ import annotations

from langchain_core.tools import BaseTool

from ..models import AgentId, validate_capabilities
from .context import ToolContext
from .files import file_tools
from .git import git_tools
from .shell import shell_tools
from .todos import todo_tools
from .web import web_tools

__all__ = ["CAPABILITY_TOOLS", "ToolContext", "apply_capabilities", "build_tools", "tools_for"]

_READ_ONLY = frozenset({"read_file", "list_directory", "search_files", "read_artifact"})

#: Publishing the working list touches no files, so every agent has it — the orchestrator
#: included, whose only tool this is.
_TODOS = frozenset({"update_todos"})

# ``None`` means every tool is allowed (the Code Engine owns the whole workspace).
#
# Each set has to cover what the agent's own prompt tells it to do, or the prompt is a lie the
# model discovers halfway through a phase: the architect writes the plan *and* the design mocks
# (one HTML file per screen), and the QA writes the patches it is asked to produce. Neither needs
# the shell — the architect does not run commands, and the QA's commands go through `run_tests`.
#
# Reading a page is useful to whoever works against a library it cannot see: the architect while
# planning and designing, the code engine while building, the QA while checking an expectation.
# The orchestrator is left out — its turns are briefs and verdicts built from the workspace. A set
# entry is not a permission: `web` is a *capability* the user grants, and it has to be on as well.
_WEB = frozenset({"fetch_url"})

_AGENT_TOOLS: dict[AgentId, frozenset[str] | None] = {
    AgentId.ORCHESTRATOR: _READ_ONLY | _TODOS,
    AgentId.ARCHITECT: _READ_ONLY | {"write_artifact", "write_file"} | _TODOS | _WEB,
    AgentId.CODE_ENGINE: None,
    AgentId.QA: _READ_ONLY
    | {"write_artifact", "write_file", "run_command", "run_tests", "git_status"}
    | _TODOS
    | _WEB,
}

#: What each capability in ``models.CAPABILITIES`` admits. The filter built from this can only ever
#: *remove* tools: a tool is withheld when the capability that admits it is not enabled, and a tool
#: no capability admits (every read-only tool) is untouched — so an agent can never be granted one
#: its own set withholds, and the orchestrator stays read-only whatever the user turns on.
CAPABILITY_TOOLS: dict[str, frozenset[str]] = {
    "web": frozenset({"fetch_url"}),
    "commands": frozenset({"run_command"}),
    "todos": _TODOS,
    "write": frozenset({"write_file", "write_artifact", "delete_file"}),
    "tests": frozenset({"run_tests"}),
    "git": frozenset({"git_status", "git_init", "git_branch", "git_commit", "git_push"}),
}


def build_tools(ctx: ToolContext) -> list[BaseTool]:
    """Build every workspace tool bound to ``ctx``."""
    return [
        *file_tools(ctx),
        *shell_tools(ctx),
        *git_tools(ctx),
        *todo_tools(ctx),
        *web_tools(ctx),
    ]


def _agent_tools(agent: AgentId, ctx: ToolContext) -> list[BaseTool]:
    """Every tool the agent may call by role, before the user's capabilities are considered."""
    tools = build_tools(ctx)
    allowed = _AGENT_TOOLS[agent]
    if allowed is None:
        return tools
    return [candidate for candidate in tools if candidate.name in allowed]


def apply_capabilities(
    tools: list[BaseTool], capabilities: list[str] | None
) -> list[BaseTool]:
    """Drop the tools whose capability is not enabled. ``None`` drops nothing.

    Applied on top of an agent's own set, so this narrows and never widens: a tool no capability
    admits (every read-only tool) is left alone, and one an agent's set withholds stays withheld.
    """
    if capabilities is None:
        return tools

    # Validated here as well as at the transport: an unknown id reaching this far would otherwise
    # be ignored, running the agent with every capability the caller meant to withhold.
    enabled = frozenset(validate_capabilities(capabilities) or ())
    withheld = frozenset().union(
        *(names for capability, names in CAPABILITY_TOOLS.items() if capability not in enabled)
    )
    return [candidate for candidate in tools if candidate.name not in withheld]


def tools_for(
    agent: AgentId,
    ctx: ToolContext,
    *,
    capabilities: list[str] | None = None,
) -> list[BaseTool]:
    """Return the tool subset the given agent may call.

    ``capabilities`` is the user's per-session choice of what the agent may do; ``None`` means no
    restriction, which is what an API caller that does not care gets.
    """
    return apply_capabilities(_agent_tools(agent, ctx), capabilities)
