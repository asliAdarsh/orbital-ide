"""Pydantic models for the Orbital backend.

This module is the Python half of the wire contract. It mirrors
``src/types/protocol.ts`` field-for-field.

Wire-format rule: every model inherits :class:`APIModel`, which aliases
snake_case python attributes to camelCase JSON. All HTTP handlers return plain
models from FastAPI (which serialises with ``by_alias=True`` via the router
``response_model_by_alias`` default) and every WebSocket frame is built with
:func:`event`, which dumps with ``by_alias=True`` explicitly.
"""

from __future__ import annotations

import time
from enum import StrEnum
from pathlib import Path
from typing import Any, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from orbital_backend.errors import OrbitalError

PROTOCOL_VERSION = 1
BACKEND_VERSION = "0.1.0"


class APIModel(BaseModel):
    """Base model that speaks camelCase on the wire and snake_case in python."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
    )


# --------------------------------------------------------------------------------------
# Enumerations — values must match the TypeScript string unions exactly.
# --------------------------------------------------------------------------------------


class Phase(StrEnum):
    PLAN = "plan"
    DESIGN = "design"
    BUILD = "build"
    TEST = "test"
    SYNC = "sync"


class AgentId(StrEnum):
    ORCHESTRATOR = "orchestrator"
    ARCHITECT = "architect"
    CODE_ENGINE = "code_engine"
    QA = "qa"


class PhaseStatus(StrEnum):
    IDLE = "idle"
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    ERROR = "error"


class RunStatus(StrEnum):
    IDLE = "idle"
    RUNNING = "running"
    #: The run stopped at a step boundary and its state is intact: ``resume`` continues it, where
    #: ``cancelled`` discards. A paused run is not a finished one, which is why it is its own
    #: value rather than an idle state the composer would offer to start over from.
    PAUSED = "paused"
    DONE = "done"
    ERROR = "error"
    CANCELLED = "cancelled"


class MessageRole(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    TOOL = "tool"


class BranchStrategyId(StrEnum):
    TRUNK = "trunk"
    GITHUB_FLOW = "github-flow"
    GIT_FLOW = "git-flow"


class ProviderKind(StrEnum):
    """The shapes a provider profile takes.

    ``OPENAI_COMPATIBLE`` is every hosted provider — each one publishes an endpoint that speaks
    OpenAI's chat-completions shape, some through a compatibility layer of their own. ``LOCAL`` is
    the same client pointed at a server on this machine or the user's network: no key, and an
    endpoint that may simply be off. ``ORBITAL`` is this repository's own gateway (``gateway/``):
    the same client again, at a URL the client derives from its Firebase project, presenting the
    signed-in account's ID token in place of a key, so nothing is pasted and the Orbital key stays
    server-side. In every other respect it is configured like ``OPENAI_COMPATIBLE`` — a base URL
    and a model — which is why the run path needs no case for it.
    """

    OPENAI_COMPATIBLE = "openai-compatible"
    ORBITAL = "orbital"
    LOCAL = "local"


PHASE_ORDER: tuple[Phase, ...] = (Phase.PLAN, Phase.DESIGN, Phase.BUILD, Phase.TEST, Phase.SYNC)

# Agent that owns each phase (see the orchestration diagram in the README).
PHASE_AGENT: dict[Phase, AgentId] = {
    Phase.PLAN: AgentId.ARCHITECT,
    Phase.DESIGN: AgentId.ARCHITECT,
    Phase.BUILD: AgentId.CODE_ENGINE,
    Phase.TEST: AgentId.QA,
    Phase.SYNC: AgentId.CODE_ENGINE,
}


#: Everything the pipeline writes about a project lives under one folder, so the project's root
#: holds the application and nothing else. Mirrored in ``frontend/src/types/protocol.ts``.
AGENT_DIR = "agent"
DESIGN_DIR = f"{AGENT_DIR}/design"
PLAN_PATH = f"{AGENT_DIR}/plan.md"
TEST_REPORT_PATH = f"{AGENT_DIR}/test-report.md"
AGENTS_MD_PATH = f"{AGENT_DIR}/Agents.md"

#: Files the orchestrator mirrors into session state as named artefacts, by relative path.
ARTIFACT_PATHS: tuple[str, ...] = (PLAN_PATH, TEST_REPORT_PATH, AGENTS_MD_PATH)

#: Basenames ``write_artifact`` accepts; resolved under :data:`AGENT_DIR`.
ARTIFACT_NAMES: tuple[str, ...] = tuple(Path(name).name for name in ARTIFACT_PATHS)


def artifact_relative_path(name: str) -> str | None:
    """Canonical ``agent/…`` path for an artefact name, or ``None`` when it is not one.

    Accepts either the bare name a model naturally writes (``plan.md``) or the full relative path,
    so a prompt can say "write agent/plan.md" without the tool rejecting it.
    """
    basename = Path(name).name
    for allowed in ARTIFACT_PATHS:
        if Path(allowed).name == basename:
            return allowed
    return None


class PhaseInfo(APIModel):
    id: Phase
    index: int
    title: str
    agent: AgentId
    deliverable: str
    description: str


PHASE_SPECS: tuple[PhaseInfo, ...] = (
    PhaseInfo(
        id=Phase.PLAN,
        index=1,
        title="Planning & Research",
        agent=AgentId.ARCHITECT,
        deliverable=PLAN_PATH,
        description=(
            "Talks the idea through with the user, then writes the agreed plan to agent/plan.md."
        ),
    ),
    PhaseInfo(
        id=Phase.DESIGN,
        index=2,
        title="UI Design",
        agent=AgentId.ARCHITECT,
        deliverable=f"{DESIGN_DIR}/*.html",
        description=(
            "Builds one real HTML page per screen in agent/design/, previewable in the IDE and "
            "revised on request."
        ),
    ),
    PhaseInfo(
        id=Phase.BUILD,
        index=3,
        title="Build Application",
        agent=AgentId.CODE_ENGINE,
        deliverable="source tree",
        description=(
            "Writes the codebase file-by-file using local file tools and installs dependencies "
            "in the workspace shell."
        ),
    ),
    PhaseInfo(
        id=Phase.TEST,
        index=4,
        title="Test & Debug",
        agent=AgentId.QA,
        deliverable=TEST_REPORT_PATH,
        description=(
            "Runs the project's test and lint commands, parses failures, and hands structured "
            "patches to the Code Engine."
        ),
    ),
    PhaseInfo(
        id=Phase.SYNC,
        index=5,
        title="Repository Sync",
        agent=AgentId.CODE_ENGINE,
        deliverable="git remote",
        description=(
            "Stages, commits and pushes the verified workspace to the configured remote "
            "repository."
        ),
    ),
)


PHASE_SPEC_BY_ID: dict[Phase, PhaseInfo] = {info.id: info for info in PHASE_SPECS}


def next_phase(phase: Phase) -> Phase | None:
    """Return the phase that follows ``phase``, or ``None`` at the end of the pipeline."""
    idx = PHASE_ORDER.index(phase)
    return PHASE_ORDER[idx + 1] if idx + 1 < len(PHASE_ORDER) else None


# --------------------------------------------------------------------------------------
# Domain models
# --------------------------------------------------------------------------------------


class FileNode(APIModel):
    name: str
    path: str
    type: Literal["file", "directory"]
    size: int = 0
    children: list[FileNode] | None = None
    ignored: bool | None = None


class FileContent(APIModel):
    path: str
    content: str
    language: str
    truncated: bool = False
    bytes: int = 0


class GitChange(APIModel):
    path: str
    status: str
    staged: bool


class GitStatus(APIModel):
    available: bool
    repo: bool
    branch: str | None = None
    dirty: bool = False
    ahead: int = 0
    behind: int = 0
    remote: str | None = None
    changed: list[GitChange] = Field(default_factory=list)
    error: str | None = None


class CommandResult(APIModel):
    command: str
    cwd: str
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = 0
    truncated: bool = False
    timed_out: bool = False
    cancelled: bool = False
    error: str | None = None


class ToolCall(APIModel):
    id: str
    name: str
    args: dict[str, Any] = Field(default_factory=dict)
    started_at: int
    agent: AgentId


class ToolResult(APIModel):
    id: str
    name: str
    ok: bool
    duration_ms: int
    output: str = ""
    truncated: bool = False
    error: str | None = None


class ChatMessage(APIModel):
    id: str
    role: MessageRole
    agent: AgentId
    content: str
    phase: Phase | None = None
    created_at: int
    streaming: bool = False
    tool_calls: list[ToolCall] = Field(default_factory=list)


class UsageSnapshot(APIModel):
    """What a session has consumed, measured by Orbital rather than reported by the gateway.

    Gateway token counts proved unreliable (one run reported ~9M input tokens for a single
    call), so this counts what Orbital actually sent and received. ``context_tokens`` is the
    high-water mark of a single prompt — the honest measure of context-window pressure.
    """

    model_calls: int = 0
    tool_calls: int = 0
    prompt_chars: int = 0
    completion_chars: int = 0
    context_tokens: int = 0
    #: The window ``context_tokens`` is measured against; 0 when the model's is unknown.
    context_window: int = 0
    running_ms: int = 0


class SessionState(APIModel):
    session_id: str
    project_path: str | None = None
    active_phase: Phase = Phase.PLAN
    status: RunStatus = RunStatus.IDLE
    phases: dict[Phase, PhaseStatus] = Field(
        default_factory=lambda: {phase: PhaseStatus.IDLE for phase in PHASE_ORDER}
    )
    messages: list[ChatMessage] = Field(default_factory=list)
    artifacts: dict[str, str] = Field(default_factory=dict)
    error: str | None = None
    usage: UsageSnapshot = Field(default_factory=UsageSnapshot)
    #: Commands held for the user's decision. Part of the state the socket resends, so a client
    #: that reconnects is told about a request it would otherwise never see.
    pending_commands: list[CommandRequest] = Field(default_factory=list)


# --------------------------------------------------------------------------------------
# Request / response bodies
# --------------------------------------------------------------------------------------


class OpenProjectRequest(APIModel):
    path: str


class BranchStrategyInfo(APIModel):
    """One branching model a project's build and sync phases work to."""

    id: BranchStrategyId
    label: str
    summary: str
    #: The branches the model uses, as one line the launcher can show under the label.
    branches: str
    #: Handed to the agents verbatim, so it is written as an instruction to an engineer: which
    #: branches exist, where work lands, what is merged and when.
    workflow: str


#: The models the launcher offers and validates against. One source for both, so the instructions
#: the agents are given and the ids ``branchStrategy`` accepts cannot disagree.
BRANCH_STRATEGIES: tuple[BranchStrategyInfo, ...] = (
    BranchStrategyInfo(
        id=BranchStrategyId.TRUNK,
        label="Trunk-based",
        summary="One branch, always releasable: every change lands on main and ships from there.",
        branches="main",
        workflow=(
            "Work on `main` and nowhere else: commit every change straight to `main`, and push "
            "after every green test run. Keep each commit small enough to revert on its own, and "
            "never leave `main` failing."
        ),
    ),
    BranchStrategyInfo(
        id=BranchStrategyId.GITHUB_FLOW,
        label="GitHub flow",
        summary="Short-lived branches off main, merged back through a pull request.",
        branches="main, feat/*, fix/*",
        workflow=(
            "Branch off `main` for every change — `feat/<slug>` for a feature, `fix/<slug>` for a "
            "fix — commit there, and merge back into `main` through a pull request once the tests "
            "pass. Delete the branch after the merge: `main` is always deployable and no other "
            "long-lived branch exists."
        ),
    ),
    BranchStrategyInfo(
        id=BranchStrategyId.GIT_FLOW,
        label="Git flow",
        summary="main and develop held apart, with feature, release and hotfix branches between.",
        branches="main, develop, feature/*, release/*, hotfix/*",
        workflow=(
            "Cut `feature/<slug>` from `develop` and merge it back into `develop` when it is "
            "done. When a release is ready, cut `release/<version>` from `develop`, stabilise it "
            "there, then merge it into `main` (tagging the merge) and back into `develop`. Fix a "
            "shipped bug on `hotfix/<version>` branched from `main`, and merge that into both "
            "`main` and `develop`. Only released code reaches `main`."
        ),
    ),
)


class BranchStrategiesResponse(APIModel):
    """The branching models a project can be created against. The client renders this list."""

    strategies: list[BranchStrategyInfo]


class CapabilityInfo(APIModel):
    """One thing an agent may be allowed to do, in the terms the config dialog shows it."""

    id: str
    label: str
    description: str
    #: Whether the capability is on by default in each of the composer's two modes. Plan researches
    #: and writes the plan, so it reads the web and writes files but runs nothing; Build does it all.
    plan_default: bool
    build_default: bool


#: What an agent may do, in the order the composer's config dialog renders it. One source for the
#: ids the API accepts, the labels and descriptions the dialog shows, and each mode's defaults, so
#: the UI cannot offer a capability the backend does not enforce — or disagree with it about a
#: default. Enforced by ``tools.CAPABILITY_TOOLS``.
CAPABILITIES: tuple[CapabilityInfo, ...] = (
    CapabilityInfo(
        id="web",
        label="Web",
        description="Read documentation and reference pages from the internet.",
        plan_default=True,
        build_default=True,
    ),
    CapabilityInfo(
        id="commands",
        label="Commands",
        description="Run shell commands in the project.",
        plan_default=False,
        build_default=True,
    ),
    CapabilityInfo(
        id="todos",
        label="Todos",
        description="Publish the working list the user watches while the agent works.",
        plan_default=True,
        build_default=True,
    ),
    CapabilityInfo(
        id="write",
        label="Write files",
        description="Create, edit and delete files — the plan, the design mocks and the source.",
        plan_default=True,
        build_default=True,
    ),
    CapabilityInfo(
        id="tests",
        label="Tests",
        description="Run the project's test suite and read its failures.",
        plan_default=False,
        build_default=True,
    ),
    CapabilityInfo(
        id="git",
        label="Git",
        description="Branch, commit and push the project's repository.",
        plan_default=False,
        build_default=True,
    ),
)

CAPABILITY_IDS: frozenset[str] = frozenset(info.id for info in CAPABILITIES)


class CapabilitiesResponse(APIModel):
    """What an agent may be allowed to do. The client renders this list and hardcodes nothing."""

    capabilities: list[CapabilityInfo]


class CapabilityError(OrbitalError):
    """A capability id the backend does not publish.

    The caller's mistake, not the server's, so it answers 400 rather than the base class's 500.
    """

    status_code = 400


def validate_capabilities(ids: list[str] | None) -> list[str] | None:
    """Return the capability ids to enable, refusing any the backend does not know.

    ``None`` stays ``None``: no restriction, for an API caller that does not care.

    Raises:
        CapabilityError: for an id outside :data:`CAPABILITY_IDS`. Dropping it silently would run
            the agent with every capability the caller meant to withhold, which is the one
            direction this must never fail in.
    """
    if ids is None:
        return None
    unknown = sorted({capability for capability in ids if capability not in CAPABILITY_IDS})
    if unknown:
        raise CapabilityError(
            f"unknown capability: {', '.join(unknown)}; expected any of "
            f"{', '.join(info.id for info in CAPABILITIES)}"
        )
    return ids


class ProjectEntry(APIModel):
    """One project in the user's registry, as the dashboard's launcher lists it."""

    id: str
    name: str
    #: Absolute directory on disk — what the dashboard opens the IDE on.
    path: str
    description: str | None = None
    #: Epoch seconds.
    created_at: int
    #: Zero means the project has never been opened; the launcher shows it as such rather than
    #: inventing a date.
    last_opened_at: int
    #: Pinned to the top of the launcher by the user. Defaults to false so a registry written
    #: before this field existed reads back as "not a favourite".
    favourite: bool = False
    #: The Git repository the build and sync phases push to, and the branching model they work to.
    #: One setting in two halves, so a project has both or neither; a registry written before
    #: either existed reads back as neither.
    repository: str | None = None
    branch_strategy: str | None = None


class CreateProjectRequest(APIModel):
    """Create the directory ``parent/name`` and register it."""

    parent: str
    name: str
    description: str | None = None
    repository: str | None = None
    branch_strategy: str | None = None


class UpdateProjectRequest(APIModel):
    """Partial edit of a registered project. ``None`` leaves that field alone.

    ``clear_recent`` is not a stored field: it means "I have not opened this lately", which the
    registry records by setting ``lastOpenedAt`` to zero. An empty ``repository`` is the way to
    clear the repository, and it clears the branch strategy with it.
    """

    name: str | None = None
    description: str | None = None
    favourite: bool | None = None
    clear_recent: bool | None = None
    repository: str | None = None
    branch_strategy: str | None = None


class ProjectsResponse(APIModel):
    projects: list[ProjectEntry]


class CreateProjectResponse(APIModel):
    project: ProjectEntry


class DocsResponse(APIModel):
    """The documentation the help view renders, and whether it came from the checkout."""

    markdown: str
    source: str


class WriteFileRequest(APIModel):
    path: str
    content: str


class ExecRequest(APIModel):
    command: str
    cwd: str | None = None
    timeout: int | None = None


class GitCommitRequest(APIModel):
    message: str
    paths: list[str] | None = None


class GitPushRequest(APIModel):
    remote: str | None = None
    branch: str | None = None


class GitInitRequest(APIModel):
    remote: str | None = None


# --------------------------------------------------------------------------------------
# Provider profiles — the endpoints a run may talk to, and where each one points by default.
#
# The client's mirror of this section arrives with the onboarding UI that renders it; until then
# these shapes exist only on this side of the wire.
# --------------------------------------------------------------------------------------


#: Where a profile's model list came from: the provider's own ``/models`` answer, or the curated
#: seed its preset carries. ``None`` on a profile that has never been connected, which is why the
#: empty list and the unfetched one are distinguishable.
ModelSource = Literal["provider", "preset"]


class ProviderPreset(APIModel):
    """One provider the picker offers, with the values a profile starts from.

    Every preset is OpenAI-compatible: the four agents speak OpenAI's chat-completions shape, and
    each provider here publishes an endpoint that accepts it — Anthropic and Gemini through the
    compatibility layers they ship, Ollama and LM Studio because they were built to match it.

    ``orbital`` is the one exception to "the preset carries the values", and only in the URL: the
    gateway's address is built from the client's own Firebase project and from whether that build
    talks to the emulator, so the client derives it and the preset has no URL to offer.
    """

    id: str
    label: str
    kind: ProviderKind
    #: Prefilled into a new profile and editable there: a company gateway, a proxy or a different
    #: port is the same preset with another URL. ``None`` for a preset whose URL the client
    #: computes, which today means only ``orbital``.
    base_url: str | None = None
    #: Prefilled too. The live model list replaces it once the endpoint answers.
    model: str
    #: Whether this endpoint cannot answer without a key. The form asks for one; the backend still
    #: stores a keyless profile, because the connection test is what tells the user it is missing.
    api_key_required: bool
    #: What the dropdown shows when the provider itself will not list its models. A **maintained
    #: seed**, not discovered truth: it is the preset's own model plus the ids this repository last
    #: saw offered, and a provider that answers ``/models`` replaces it wholesale. Off the wire on
    #: purpose — the client renders the list the connect step stored, never this table — so the
    #: preset payload keeps the shape the settings page and the onboarding form already read.
    #: Empty for ``orbital``, ``ollama`` and ``lmstudio``, which each serve ``/models`` themselves
    #: whenever they are up: a seed for one of those would be a guess about someone else's machine,
    #: and an empty tuple is what makes the connect step ask for a model by hand instead.
    fallback_models: tuple[str, ...] = Field(default=(), exclude=True)


#: The providers the settings page offers, and the only list either side needs: the client renders
#: this table as it arrives and hardcodes nothing, so a provider is added here and nowhere else.
#: Ordered the way the page shows them — the account's own gateway first, because it is the one
#: that asks for nothing pasted; then the endpoint this repository defaults to; the local runtime
#: last.
PROVIDER_PRESETS: tuple[ProviderPreset, ...] = (
    ProviderPreset(
        id="orbital",
        label="Orbital",
        kind=ProviderKind.ORBITAL,
        # No URL: the client builds it from its Firebase project id, and from the emulator flag —
        # `http://127.0.0.1:5001/<project>/us-central1/orbital/v1` locally, the deployed
        # `https://us-central1-<project>.cloudfunctions.net/orbital/v1` otherwise. A placeholder
        # here would be a URL that is wrong for every deployment.
        base_url=None,
        # The gateway's catalogue today, and the model a profile is created with when the
        # catalogue call failed. The live list replaces it whenever the gateway answers.
        model="deepseek-v4-flash",
        # The "key" is the signed-in account's ID token, which the app refreshes and stores
        # itself; the form never asks for one.
        api_key_required=False,
    ),
    ProviderPreset(
        id="opencode-go",
        label="OpenCode Go",
        kind=ProviderKind.OPENAI_COMPATIBLE,
        base_url="https://opencode.ai/zen/go/v1",
        model="deepseek-v4-flash",
        api_key_required=True,
        fallback_models=("deepseek-v4-flash", "deepseek-v4-pro"),
    ),
    ProviderPreset(
        id="zen",
        label="OpenCode Zen",
        kind=ProviderKind.OPENAI_COMPATIBLE,
        base_url="https://opencode.ai/zen/v1",
        model="deepseek-v4-flash",
        api_key_required=True,
        fallback_models=("deepseek-v4-flash", "deepseek-v4-pro"),
    ),
    ProviderPreset(
        id="openai",
        label="OpenAI",
        kind=ProviderKind.OPENAI_COMPATIBLE,
        base_url="https://api.openai.com/v1",
        model="gpt-4o",
        api_key_required=True,
        fallback_models=("gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"),
    ),
    ProviderPreset(
        id="anthropic",
        label="Anthropic (Claude)",
        kind=ProviderKind.OPENAI_COMPATIBLE,
        # Anthropic's OpenAI-compatibility layer, so a Claude model arrives in the shape the
        # agents already speak rather than needing a second client.
        base_url="https://api.anthropic.com/v1",
        model="claude-sonnet-4-20250514",
        api_key_required=True,
        fallback_models=(
            "claude-sonnet-4-20250514",
            "claude-opus-4-20250514",
            "claude-3-7-sonnet-20250219",
            "claude-3-5-haiku-20241022",
        ),
    ),
    ProviderPreset(
        id="gemini",
        label="Google Gemini",
        kind=ProviderKind.OPENAI_COMPATIBLE,
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        model="gemini-2.0-flash",
        api_key_required=True,
        fallback_models=("gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"),
    ),
    ProviderPreset(
        id="grok",
        label="xAI Grok",
        kind=ProviderKind.OPENAI_COMPATIBLE,
        base_url="https://api.x.ai/v1",
        model="grok-3",
        api_key_required=True,
        fallback_models=("grok-4", "grok-3", "grok-3-mini"),
    ),
    ProviderPreset(
        id="deepseek",
        label="DeepSeek",
        kind=ProviderKind.OPENAI_COMPATIBLE,
        base_url="https://api.deepseek.com/v1",
        model="deepseek-chat",
        api_key_required=True,
        fallback_models=("deepseek-chat", "deepseek-reasoner"),
    ),
    ProviderPreset(
        id="vercel",
        label="Vercel AI Gateway",
        kind=ProviderKind.OPENAI_COMPATIBLE,
        base_url="https://ai-gateway.vercel.sh/v1",
        # The gateway names models ``provider/model``, which is what the picker lists for it.
        model="openai/gpt-4o",
        api_key_required=True,
        fallback_models=(
            "openai/gpt-4o",
            "anthropic/claude-sonnet-4",
            "google/gemini-2.0-flash",
        ),
    ),
    # The two local runtimes are separate presets rather than one, because the *port* is the
    # whole difference and the wrong one is a connection refused: Ollama answers on 11434, LM
    # Studio on 1234, and a user who picked "local model" had a 50% chance of starting from an
    # endpoint nothing was listening on. Both keep the ``local`` kind, which is what decides the
    # loopback allowance and the "no key needed" rule — the id is only a label for the picker.
    ProviderPreset(
        id="ollama",
        label="Ollama",
        kind=ProviderKind.LOCAL,
        base_url="http://127.0.0.1:11434/v1",
        # A published Ollama model, not a guess about the user's machine: Ollama pulls on demand,
        # so `ollama run llama3.1` makes this true, and it is editable either way. Ollama serves
        # `/v1/models` (since 0.1.24), so connect replaces this list with what is actually pulled.
        model="llama3.1",
        api_key_required=False,
    ),
    ProviderPreset(
        id="lmstudio",
        label="LM Studio",
        kind=ProviderKind.LOCAL,
        base_url="http://127.0.0.1:1234/v1",
        # LM Studio has no pull-on-demand and no catalogue: only what the user downloaded exists,
        # under the repo-style ids it shows in its own UI. This is the starting value, and the
        # connect step lists what this machine actually has loaded.
        model="google/gemma-4-e4b",
        api_key_required=False,
    ),
)


#: How much of a stored key may be shown back, and how long a key must be before showing that much
#: says anything: four characters identify a key in a list, while four characters of a short value
#: are most of the value.
API_KEY_HINT_LENGTH = 4
API_KEY_HINT_MIN_LENGTH = 12


class ProviderProfile(APIModel):
    """One configured endpoint, as it is stored.

    The stored shape and the wire shape are deliberately two models. This one holds ``api_key``,
    and :class:`ProviderProfileInfo` — the only shape any handler returns — has no field a key
    could travel in, so a response that leaks one is not something a serialiser setting can cause.
    """

    id: str
    label: str
    kind: ProviderKind
    base_url: str
    #: The model a run uses unless the caller names another one.
    model: str
    #: What this endpoint last said it serves, or the curated seed when it would not say. Stored
    #: rather than probed per request, so the dropdown opens without a network call and a provider
    #: that is temporarily down does not empty the list it already answered.
    models: list[str] = Field(default_factory=list)
    #: When :attr:`models` was stored, in epoch seconds — ``None`` when nothing has been connected.
    models_fetched_at: int | None = None
    #: Which of the two sources :attr:`models` came from, or ``None`` before the first connect.
    models_source: ModelSource | None = None
    #: The profile's credential. It lives in the profile file, which is restricted to the account
    #: that wrote it, and nowhere else — not in ``.env``, not in a log line, not in a response.
    api_key: str | None = None
    active: bool = False
    created_at: int

    def info(self) -> ProviderProfileInfo:
        """The wire view: the key reduced to whether there is one, and its last few characters."""
        key = (self.api_key or "").strip()
        return ProviderProfileInfo(
            id=self.id,
            label=self.label,
            kind=self.kind,
            base_url=self.base_url,
            model=self.model,
            models=list(self.models),
            models_fetched_at=self.models_fetched_at,
            models_source=self.models_source,
            api_key_set=bool(key),
            api_key_hint=(
                key[-API_KEY_HINT_LENGTH:] if len(key) >= API_KEY_HINT_MIN_LENGTH else None
            ),
            active=self.active,
            created_at=self.created_at,
        )


class ProviderProfileInfo(APIModel):
    """A stored profile as the API returns it — never the key itself."""

    id: str
    label: str
    kind: ProviderKind
    base_url: str
    model: str
    #: The endpoint's own models when it listed them, the curated seed when it would not, and
    #: empty until the connect step has run. ``modelsSource`` says which of the two it is, and
    #: ``None`` when nothing has been fetched — an empty list and an unfetched one are different
    #: answers, and the UI has to be able to tell them apart.
    models: list[str] = Field(default_factory=list)
    models_fetched_at: int | None = None
    models_source: ModelSource | None = None
    api_key_set: bool
    #: The last four characters, enough to tell two keys apart in a list; ``None`` when there is
    #: no key or the key is too short for its tail to be anything but the key.
    api_key_hint: str | None
    active: bool
    created_at: int


class ProvidersResponse(APIModel):
    """The whole list, which is what every profile mutation returns: the client then redraws it
    from one shape instead of reconciling four."""

    profiles: list[ProviderProfileInfo]
    #: The profile a run talks to, or ``None`` when the user has configured none.
    active_id: str | None = None
    #: Something the user has to know about a mutation that nevertheless succeeded — today, that a
    #: profile holding a key now points at a different host. ``None`` when there is nothing to say.
    notice: str | None = None


class CreateProviderRequest(APIModel):
    """``kind`` arrives as text so an unknown one is a refusal naming the accepted values rather
    than a 422 from the enum's own parser (the same reason ``branchStrategy`` is a string)."""

    label: str
    kind: str
    base_url: str
    model: str
    api_key: str | None = None


class UpdateProviderRequest(APIModel):
    """Partial edit. ``None`` leaves a field as it was; an empty ``api_key`` clears it."""

    label: str | None = None
    base_url: str | None = None
    model: str | None = None
    api_key: str | None = None


class ProviderTestResponse(APIModel):
    """The outcome of one authenticated call to a profile's endpoint.

    A refused key is an answer, not an error: the endpoint's own words come back here and the
    request still succeeds.
    """

    ok: bool
    detail: str
    models: list[str] = Field(default_factory=list)


class ProviderConnectResponse(APIModel):
    """The outcome of the connect step: ask the endpoint what it serves, and store the answer.

    ``ok`` false travels with HTTP 200, because it is one of the answers the user asked for — a
    refused key, or a provider that will not list its models *and* has no curated seed to offer.
    ``source`` is never absent: whichever list comes back, this says whether the provider or the
    preset produced it, and a preset with nothing curated still reports ``"preset"`` so the UI can
    say where the empty dropdown came from.
    """

    ok: bool
    detail: str
    models: list[str] = Field(default_factory=list)
    source: ModelSource


class ProviderModelsResponse(APIModel):
    """What a profile has stored: the list, where it came from, and when.

    Read from the store with no network call, because this is what a dropdown opens on — a
    provider that is slow, rate-limiting or off must not be able to delay a picker that already
    has an answer from the last connect.
    """

    models: list[str] = Field(default_factory=list)
    source: ModelSource | None = None
    fetched_at: int | None = None


class ProviderPresetsResponse(APIModel):
    """The providers a profile can be created from. The client renders this list as it arrives."""

    presets: list[ProviderPreset]


class ModelInfo(APIModel):
    id: str
    owned_by: str | None = None


class ModelsResponse(APIModel):
    models: list[ModelInfo]
    default: str
    #: Where the list came from — "gateway" or "fallback" when the gateway was unreachable.
    source: str


#: The effort levels ``reasoningEffort`` may name, and the only ones passed through to the model.
#: A gateway that does not know the parameter answers a request carrying it with an error, so an
#: unlisted value is refused here rather than forwarded — and dropping it silently would run the
#: model at its default while the UI claimed otherwise.
REASONING_EFFORTS: tuple[str, ...] = ("minimal", "low", "medium", "high")


def validate_reasoning_effort(value: str | None) -> str | None:
    """Return the effort to send to the model, or ``None`` to send no parameter at all.

    Raises:
        OrbitalError: for any value outside :data:`REASONING_EFFORTS`. Both transports turn that
            into a refusal the caller can read — HTTP 400, or an ``error`` frame.
    """
    if value is None:
        return None
    if value not in REASONING_EFFORTS:
        raise OrbitalError(
            f"unknown reasoningEffort {value!r}; expected one of {', '.join(REASONING_EFFORTS)}"
        )
    return value


#: The composer's approval mode. ``ask`` keeps the approval card on every command; ``allow_all``
#: runs them without asking — the standing choice the user made in the UI, not the card's
#: run-scoped "allow all in this run", which ends with the run. ``None`` means ``ask``.
Permission = Literal["ask", "allow_all"]


class RunAgentRequest(APIModel):
    session_id: str
    phase: Phase
    prompt: str
    project_path: str
    auto_advance: bool = False
    #: Overrides ORBITAL_LLM_MODEL for this run only.
    model: str | None = None
    #: Pin this run to one provider profile instead of the active one: its base URL, its key and
    #: its model. ``None`` means the active profile, as every run did before profiles could be
    #: named here. The active badge does not move — this is a run's choice, not a settings edit.
    provider_id: str | None = None
    #: Workspace-relative paths whose contents are added to the phase brief.
    attachments: list[str] | None = None
    reasoning_effort: str | None = None
    #: Capability ids the user enabled, from ``GET /api/capabilities``. ``None`` means no
    #: restriction; an id the backend does not know is refused (see :func:`validate_capabilities`).
    capabilities: list[str] | None = None
    permission: Permission | None = None


class ChatTurnRequest(APIModel):
    """One conversational turn with a phase's specialist — no orchestration, no verdict."""

    session_id: str
    phase: Phase
    message: str
    project_path: str
    model: str | None = None
    #: Pin this turn to one provider profile; see :class:`RunAgentRequest`.
    provider_id: str | None = None
    #: Workspace-relative paths the user attached. A chat turn can carry an image, because its
    #: message is multimodal; a run cannot (see ``services.attachments.build_run_context``).
    attachments: list[str] | None = None
    reasoning_effort: str | None = None
    capabilities: list[str] | None = None
    permission: Permission | None = None


class PickFolderRequest(APIModel):
    """Optional tweaks for the native folder chooser."""

    title: str | None = None
    initial_dir: str | None = None


class SessionRef(APIModel):
    session_id: str


class HealthResponse(APIModel):
    status: Literal["ok"] = "ok"
    version: str = BACKEND_VERSION
    protocol_version: int = PROTOCOL_VERSION
    model: str
    #: Whether a key is set at all, which is all the config file can say.
    llm_configured: bool
    #: What the last authenticated call to the gateway revealed: ``ok``, ``rejected``, or
    #: ``unknown`` when nothing has settled it yet. A key can be present and still refused,
    #: which is the case the UI needs to show.
    llm_credential: Literal["unknown", "ok", "rejected"] = "unknown"
    llm_credential_detail: str | None = None
    missing_binaries: list[str] = Field(default_factory=list)
    uptime_seconds: int = 0


class PhasesResponse(APIModel):
    phases: list[PhaseInfo]


class ProjectResponse(APIModel):
    project_path: str | None = None
    name: str | None = None
    writable: bool = False
    git: GitStatus


class TreeResponse(APIModel):
    root: FileNode


class SessionsResponse(APIModel):
    sessions: list[SessionState]


class OkResponse(APIModel):
    ok: bool = True


class RunAccepted(APIModel):
    session_id: str
    status: RunStatus


# --------------------------------------------------------------------------------------
# Chats and skills — the conversations the sidebar lists, and the instructions a composer
# can turn into a prompt.
#
# A chat id *is* a runtime session id: one id addresses both, so the sidebar entry and the
# state a run updates can never be two different conversations.
# --------------------------------------------------------------------------------------

#: What a chat is called until its first user message names it. The same literal the client
#: starts its own placeholder with, so a chat created offline and one created here agree.
NEW_CHAT_TITLE = "New chat"

#: How much of the first message becomes the title: enough to recognise the conversation in the
#: sidebar, short enough that the row does not have to be truncated to render it.
CHAT_TITLE_LIMIT = 60


class Chat(APIModel):
    """One conversation, as the sidebar lists it and as the socket addresses it.

    ``renamed`` never reaches the wire — it is the flag that decides whether a later message may
    still name the chat, and the client has nothing to do with it.
    """

    id: str
    title: str = NEW_CHAT_TITLE
    workspace: str | None = None
    phase: Phase = Phase.PLAN
    provider_id: str | None = None
    model: str | None = None
    created_at: int = 0
    updated_at: int = 0
    message_count: int = 0
    run_status: RunStatus = RunStatus.IDLE
    #: True once the user has named the chat, by creating it with a title or by renaming it.
    renamed: bool = Field(default=False, exclude=True)


class ChatsResponse(APIModel):
    """Every chat, newest activity first — which is what every mutation returns."""

    chats: list[Chat]


class ChatResponse(APIModel):
    chat: Chat


class ChatStateResponse(APIModel):
    """A chat and the live session state behind it: what the composer refreshes a chat with."""

    chat: Chat
    state: SessionState


class CreateChatRequest(APIModel):
    """``workspace`` and ``phase`` are optional, so a chat can be started from anywhere."""

    title: str | None = None
    workspace: str | None = None
    phase: Phase | None = None


class UpdateChatRequest(APIModel):
    """Partial edit of a chat. ``None`` leaves that field alone."""

    title: str | None = None
    phase: Phase | None = None
    provider_id: str | None = None
    model: str | None = None


#: Where a skill was found: the open workspace's own folder, or the user's across every project.
SkillSource = Literal["workspace", "user"]


class Skill(APIModel):
    """One markdown instruction file, as the composer lists it.

    ``path`` is absolute and the app never writes it: a skill is a file the user owns and the
    backend is only ever a reader of.
    """

    id: str
    name: str
    description: str
    source: SkillSource
    path: str


class SkillsResponse(APIModel):
    skills: list[Skill]


class SkillResponse(APIModel):
    """One skill and its markdown body — the prompt the composer inserts."""

    skill: Skill
    body: str


class ConfigResponse(APIModel):
    model: str
    base_url: str
    api_key_configured: bool
    command_timeout: int
    max_output_bytes: int
    allowed_roots: list[str]
    context_window: int
    max_tokens: int


class ConfigUpdateRequest(APIModel):
    """Partial settings update. Omitted fields are untouched."""

    model: str | None = None
    base_url: str | None = None
    #: Refused rather than dropped: the credential belongs to the provider profile that owns the
    #: endpoint it was issued for, and a client still sending it has to be told so instead of
    #: believing it saved one here. It is declared for that refusal to be able to name the field.
    api_key: str | None = None
    command_timeout: int | None = None
    max_output_bytes: int | None = None
    context_window: int | None = None
    max_tokens: int | None = None
    allowed_roots: list[str] | None = None


class ConfigUpdateResponse(APIModel):
    config: ConfigResponse
    changed: list[str] = Field(default_factory=list)


class CommandRequest(APIModel):
    """A shell command the agent is holding until the user decides."""

    id: str
    agent: AgentId
    phase: Phase
    command: str
    cwd: str
    #: The tool that wants to run it, for the card's context line.
    tool: str


class SearchHit(APIModel):
    """One matching line, with a path relative to the project root."""

    path: str
    line: int
    text: str


class SearchResponse(APIModel):
    query: str
    hits: list[SearchHit]
    #: True when the hit limit was reached and more matches exist.
    truncated: bool = False


class PickFolderResponse(APIModel):
    """Result of the native folder chooser.

    ``path`` is null when the user cancelled, when a dialog was already open, or when this
    runtime cannot show one — ``available`` distinguishes the last case so the UI knows
    whether to keep offering the manual path field.
    """

    path: str | None = None
    available: bool = True
    reason: str | None = None


# --------------------------------------------------------------------------------------
# WebSocket frames
# --------------------------------------------------------------------------------------

#: The states a todo item may be in. ``TODO_STATUSES`` is derived from it so the wire union and
#: the values the tool accepts cannot drift apart.
TodoStatus = Literal["pending", "in_progress", "completed"]

TODO_STATUSES: tuple[TodoStatus, ...] = get_args(TodoStatus)


class TodoItem(APIModel):
    """One line of an agent's working list, as the composer renders it."""

    content: str
    status: TodoStatus


class TodosPayload(APIModel):
    """The agent's whole working list. Every call replaces it, so the UI never merges lists."""

    items: list[TodoItem] = Field(default_factory=list)


WsEventType = Literal[
    "session.state",
    "phase.changed",
    "agent.node",
    "agent.message.start",
    "agent.token",
    "agent.message.end",
    "agent.tool_call",
    "agent.tool_result",
    "agent.todos",
    "agent.error",
    #: A side question answered beside a run: start, tokens, end, each carrying the requestId the
    #: answer belongs to so a client can tell two of them apart. Nothing here advances the run.
    "agent.answer.start",
    "agent.answer.token",
    "agent.answer.end",
    "agent.done",
    "terminal.output",
    "terminal.exit",
    "file.changed",
    "artifact.updated",
    "usage.updated",
    "agent.command_request",
    "approval.resolved",
    "log",
    "error",
    "pong",
]


def event(
    type_: WsEventType,
    payload: BaseModel | dict[str, Any],
    *,
    session_id: str | None = None,
    seq: int = 0,
    session_seq: int | None = None,
) -> dict[str, Any]:
    """Serialise one server frame, camelCasing nested models to match protocol.ts.

    Two counters travel with every frame. ``seq`` is process-wide and orders the whole server's
    output; ``sessionSeq`` counts only the frames of this session, which is the one a client can
    actually check for gaps — a client is only sent its own session's frames, so the process-wide
    counter moves under it whenever another session is busy, and treating that as loss cries wolf.
    """
    if isinstance(payload, BaseModel):
        payload = payload.model_dump(by_alias=True, mode="json")
    return {
        "v": PROTOCOL_VERSION,
        "type": type_,
        "sessionId": session_id,
        "seq": seq,
        "sessionSeq": session_seq,
        "ts": int(time.time() * 1000),
        "payload": payload,
    }


class ClientFrame(APIModel):
    """Inbound WebSocket frame. ``payload`` keys are read per ``type``."""

    type: str
    session_id: str | None = None
    phase: Phase | None = None
    prompt: str | None = None
    project_path: str | None = None
    auto_advance: bool = False
    model: str | None = None
    #: Pin the turn to one provider profile instead of the active one. Carried on ``agent.run``
    #: and ``agent.chat``, exactly as the REST bodies carry it — the composer's runs go over this
    #: socket, so a pin that only reached the REST route would not reach the composer at all.
    provider_id: str | None = None
    message: str | None = None
    request_id: str | None = None
    #: Carried on ``agent.ask``: the side question, answered without disturbing the run. Read as a
    #: field rather than off the raw payload because this model ignores unknown keys, so a frame
    #: whose question arrived only in the JSON would be dropped here and never seen by the server.
    question: str | None = None
    approved: bool | None = None
    remember: bool = False
    command: str | None = None
    command_id: str | None = None
    cwd: str | None = None
    timeout: int | None = None
    root: str | None = None
    #: Workspace-relative paths the composer attached to this turn. ``None`` and ``[]`` mean
    #: the same thing: nothing to add to the prompt.
    attachments: list[str] | None = None
    #: Reasoning effort for every model this run builds; ``None`` sends no parameter at all.
    reasoning_effort: str | None = None
    #: Capability ids the composer enabled (``GET /api/capabilities``); ``None`` means no
    #: restriction. Carried on ``agent.run`` and ``agent.chat``.
    capabilities: list[str] | None = None
    #: The composer's approval mode for this session, on the same two frames.
    permission: Permission | None = None
