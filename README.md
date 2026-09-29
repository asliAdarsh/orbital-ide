# Orbital

An AI-driven desktop IDE that takes an application from a prompt to a pushed repository in
five phases: **plan → design → build → test → sync**.

Orbital is a Tauri v2 desktop host around a React front end and a Python agent runtime. The
runtime is a FastAPI + LangGraph service that the host launches as a sidecar and supervises;
it drives a supervisor agent plus three specialists over local file, shell and git tools, and
streams every token, tool call and terminal byte back to the UI over one WebSocket.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Tauri v2 host (Rust)                                                     │
│  · spawns + supervises the Python sidecar on a free port                 │
│  · emits backend://ready, kills the process tree on exit                 │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ React 18 + Vite + Tailwind + shadcn/ui   (webview)                 │  │
│  │  left:  phases · context artefacts · workspace tree · git          │  │
│  │  centre: phase canvas | Monaco editor | diff view                  │  │
│  │  right: agent chat · live tool inspector · logs                    │  │
│  │  bottom: xterm.js terminal · problems · output                     │  │
│  └───────────────▲────────────────────────────────┬───────────────────┘  │
└──────────────────┼────────────────────────────────┼──────────────────────┘
        REST /api │                WebSocket /ws   │
┌──────────────────┴────────────────────────────────┴──────────────────────┐
│ FastAPI + LangGraph sidecar (Python 3.11+)                              │
│                                                                         │
│              ┌───────────────────────┐                                  │
│              │ Orchestrator (state)  │  brief ▸ verdict: ADVANCE/RETRY/  │
│              └───┬─────────┬─────────┘  STOP                            │
│      ┌───────────┘         │           └────────────┐                   │
│  ┌───▼────────┐   ┌────────▼───────┐        ┌───────▼───────┐           │
│  │ Architect  │   │ Code Engine    │        │ QA            │           │
│  │ phases 1,2 │   │ phases 3,5     │        │ phase 4       │           │
│  └────────────┘   └────────────────┘        └───────────────┘           │
│        └── tools: files · shell · git · tests (workspace-contained) ──┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

## The pipeline

| # | Phase | Agent | Produces |
| --- | --- | --- | --- |
| 1 | Planning & Research | architect | `agent/plan.md` |
| 2 | UI Design | architect | `agent/design/*.html` — one real page per screen, one file per state |
| 3 | Build Application | code_engine | the source tree |
| 4 | Test & Debug | qa | `agent/test-report.md` |
| 5 | Repository Sync | code_engine | commits pushed to the remote |

The orchestrator runs twice per phase — once to write the specialist's brief, once to judge
what came back — and returns `ADVANCE`, `RETRY` (once per phase) or `STOP`. It also maintains
`agent/Agents.md`, the project-state document, rewriting it after every phase.

Everything the pipeline writes *about* the project lives under `agent/`, so the project root
holds the application and nothing else. Phase 2 is not a document: the architect writes one
self-contained HTML page per screen and the IDE previews it, so the design is judged by
looking at it and revised by talking about it.

**The plan and the design are conversations, and the agent writes them.** Phases 1 and 2 talk to
you rather than running a prompt: the canvas carries the composer, the transcript lives in the chat
panel, and the architect — which has the tools to write its own deliverable — gathers what it needs
one question at a time, writes the plan (or the mocks) when it has heard enough, and tells you to
look it over.

**Nothing to confirm until there is something to confirm.** The controls that move the work on
appear with the deliverable: the plan footer offers **Plan looks right → UI Design** only once
`agent/plan.md` exists, and the design footer offers **Design looks right → Build Application** only
once there are mocks. Confirming starts the next phase as an ordinary run, which stops again for its
own review. Wanted something different? Say so in the chat (or point at the element with the
Comment tool in the design phase) and the agent edits the file — revisions are edits to the same
document, not a fresh attempt.

**Shell commands are held for your decision.** The agent runs on your machine, so every
`run_command` and `run_tests` call stops at a card in the chat showing the exact command and
directory, with **Allow**, **Allow all in this run** and **Deny**. Nothing executes until you
answer, a denial comes back to the agent as a refusal it must not retry, and an unanswered
request times out into a refusal — silence is never consent. The blanket permission lasts
exactly as long as the run that granted it. The card travels with the session state, so a
reconnect (or a reload) while a command is held still shows the decision that is waiting.

**The design phase renders the mocks and takes notes on them.** The canvas shows the real page —
the same sandboxed frame the rest of the app uses, with `allow-scripts` and never
`allow-same-origin` — with the screens across the top and two tools beside them:

- **Comment** — click an element in the page and write what should change. Notes collect as chips
  under the tool bar; **Send N** hands them to the architect in one turn, each one naming the
  element's CSS path, so "make this row taller" arrives attached to the thing it is about.
- **Grab element** — click an element to copy its tag, selector, classes, size and text to the
  clipboard, which is what you want when pasting context into a discussion.

Picking runs *inside* the frame, because the app genuinely cannot see into it: the sandbox gives
the mock an opaque origin, so the picker is injected into the mock and reports through
`postMessage`. It reads only the document it is already sitting in, and everything it sends is
validated before the app acts on it (`lib/mock-picker.ts`).

**A repository turns into a workflow.** When a project has one, every phase's brief carries the
remote, the chosen model and what that model means — branch off `main` per change and merge back
through a pull request, or cut `feature/*` from `develop` and keep releases separate, or commit
straight to `main`. The build and sync phases then work to it with the git tools (`git_init` sets
the remote, `git_branch` switches or creates the branch, `git_commit`, `git_push`), and the branch
model is generated from the same table the dialog showed, so the branches you picked are the
branches it works on.

The agent never handles your credentials: a push that is refused for authentication is reported in
one line and the phase stops there, rather than the agent guessing at your authentication.

**The composer does more than type.** Under every message you can choose **Plan** or **Build**:

- **Plan** — the agent researches and plans *with* you. It writes the plan and the design mocks, and
  builds nothing: no commands, no tests, no git.
- **Build** — the agent does the phase's work, writing and changing the project.

The composer opens on whichever the phase usually wants (Plan for phases 1 and 2, Build for the
rest) and you can override it per message. Beside the mode:

- **Attachments.** Tick files and folders from the workspace and they travel with the message. A
  chat turn sends text files inline and images as image data, so a vision-capable model can actually
  look at a screenshot; a **run** gets the text context and the images *named*, because the phase
  briefs are plain text — a limitation the popover states rather than hides.
- **Reasoning effort** — `minimal`, `low`, `medium` or `high`, or *Default* to send nothing at all.
  It goes to the gateway as OpenAI's `reasoning_effort` and only when set, since a gateway that does
  not know the parameter may refuse the request; models without reasoning ignore it.
- **A working list.** While the agent works it keeps a todo list (its own `update_todos` tool) and
  the composer shows it above the message box — done out of total, one row per step, updated as
  steps complete. It is the agent's plan of its own turn, not yours.
- **The model, by name.** A button showing the model actually in use (the backend default when you
  have not chosen one) opens the picker — the list is long, and a dropdown that truncates the name
  tells you nothing about what is answering.
- **Permission.** *Ask for approval on every command* — the default, where each `run_command` and
  `run_tests` stops at a card — or *Allow all*, where commands run without asking. This is the
  standing setting for the session; the card's own **Allow all in this run** is the narrower one and
  lasts exactly as long as that run.
- **What the agent may do.** A config dialog, driven by `GET /api/capabilities`, where you grant or
  withhold **web, commands, todos, write files, tests and git**. The options follow the mode: in Plan
  the agent may read the web, keep its list and write the plan and mocks, and may not touch commands,
  tests or git; in Build everything is on. Withholding a capability takes the tools away rather than
  asking the model nicely, and a capability can only ever *remove* a tool the agent's role already
  allows.

The **web** capability is a tool of its own (`fetch_url`): one GET, http(s) only, a size cap, and the
page reduced to readable text — enough to read the docs for a library while planning.

**A run stops at the end of each phase.** The verdict is on screen, every artefact is on disk
and editable, and nothing else starts until you approve it — which is the point where a wrong
plan is still cheap to fix. The bar under the phase canvas shows the current phase, an
**Approve · continue to …** button, and **Re-run this phase** if the result is not what you
wanted; it also warns when a phase reported success but left no deliverable behind — a missing
`agent/plan.md` or test report, a design phase with no mocks in `agent/design/`, a build phase
with no source files. Tick **run all phases without
stopping** to chain the whole pipeline in one go instead (the preference is remembered).

## Layout

Three code directories, one per runtime, and nothing else at the root but the workspace
manifest, the ignore file and this README. Everything a given runtime needs — its own code,
configuration, dependencies and caches — lives inside that runtime's directory.

```
├── frontend/              # the web app: React + Vite + Tailwind + Monaco + xterm
│   ├── designs/           UI reference mocks
│   ├── index.html
│   ├── package.json       web dependencies and web scripts
│   ├── vite.config.ts     dev server on 5173, `@` → ./src
│   ├── tailwind.config.js design tokens (dark-only surface)
│   ├── tsconfig.json
│   ├── postcss.config.js
│   └── src/
│       ├── types/protocol.ts  wire contract      ─┐ mirrored field for field,
│       ├── store/             zustand store + frame reducer
│       ├── lib/               REST client, socket, backend discovery, Monaco, mock picker
│       ├── hooks/             boot, socket bridge, open-project, panel sizing
│       └── components/
│           ├── ui/            shadcn primitives
│           ├── common/        StatusDot, EmptyState, Toaster, ErrorBoundary…
│           ├── layout/        CentrePane (Phase tab + editor tabs)
│           ├── dashboard/     the launcher: cards, menus, create/edit/delete dialogs
│           ├── panels/        TitleBar, LeftSidebar, RightSidebar, BottomPanel,
│           │                  DesignPreview (sandboxed mock viewer)
│           ├── phases/        PhaseCanvas, PhaseGate + the five phase views
│           ├── editor/        Monaco editor, diff viewer, editor tabs, file tree
│           ├── terminal/      xterm.js panel
│           └── chat/          agent chat, message bubble, tool inspector, roster, model picker,
│                              command approval card
├── backend/               # the agent runtime: FastAPI + LangGraph
│   ├── orbital_backend/
│   │   ├── agents/        supervisor graph, prompts, run driver, usage, retry  (the 4 agents)
│   │   ├── tools/         LLM-facing file / shell / git / test tools
│   │   ├── routes/        REST routers
│   │   ├── services/      workspace containment, process runner, sessions, watcher, picker
│   │   ├── models.py      pydantic wire models                    ┘
│   │   ├── ws.py          WebSocket dispatch
│   │   └── __main__.py    uvicorn entry + readiness line
│   ├── tests/
│   ├── .env               backend configuration (template: .env.example)
│   ├── .env.example
│   ├── dev.mjs            venv-aware dev launcher (`npm run backend:dev`)
│   ├── requirements.txt
│   ├── pyproject.toml     package metadata + pytest config
│   ├── build_sidecar.py   PyInstaller → Tauri sidecar
│   └── orbital-backend.spec
├── src-tauri/             # the desktop host: Rust, sidecar supervision, capabilities, icons
├── package.json           # npm workspace root + the entry-point scripts for all three runtimes
└── .gitignore
```

Two placements are deliberate:

- **`src-tauri/` sits at the root** because the Tauri CLI discovers the desktop host there,
  relative to the directory it is invoked from. It is not frontend code — it is the host that
  packages the frontend and supervises the backend.
- **`package.json` sits at the root** because it is the npm workspace manifest that ties the
  frontend and the Tauri CLI together and holds the scripts everyone runs. Dependencies are
  hoisted to a single `node_modules/`, so `npm install` is one command rather than one per
  directory. The frontend's own dependencies are still declared in `frontend/package.json`.

`frontend/src/types/protocol.ts` and `backend/orbital_backend/models.py` are the contract
between the two processes. All field names are camelCase on the wire; Python serialises with
`by_alias=True`.

## Requirements

- **Node 20+** and npm
- **Python 3.11+** (3.14 verified)
- **git** on `PATH` for phase 5 (Orbital degrades gracefully without it)
- **Rust toolchain + Tauri prerequisites** *only* for the desktop build — see
  [Desktop build](#desktop-build)

## Setup

```bash
npm install                                         # root + frontend workspace, one pass
python -m venv .venv
.venv/Scripts/pip install -r backend/requirements.txt     # Windows
# .venv/bin/pip install -r backend/requirements.txt       # macOS / Linux

cp backend/.env.example backend/.env                # then set ORBITAL_LLM_API_KEY
```

The backend reads `backend/.env`, resolved relative to its own package, so it works whether it
is started from the repository root or with `backend/` as the working directory. Frontend-only
variables (`VITE_*`, e.g. `VITE_ORBITAL_API` to point at a non-default backend) belong in
`frontend/.env` instead — not needed for the normal flow.

All four agents use one OpenAI-compatible endpoint serving `deepseek-v4-flash`:

```ini
ORBITAL_LLM_MODEL=deepseek-v4-flash
ORBITAL_LLM_BASE_URL=https://opencode.ai/zen/go/v1
ORBITAL_LLM_API_KEY=sk-...
```

Without a key the IDE starts normally, reports `llmConfigured: false` on `/api/health`, and
refuses to start a run with a clear message instead of failing mid-graph.

### Pointing it at a gateway

| Gateway | `ORBITAL_LLM_BASE_URL` |
| --- | --- |
| OpenCode Go (subscription) | `https://opencode.ai/zen/go/v1` |
| OpenCode Zen (pay-as-you-go) | `https://opencode.ai/zen/v1` |
| Any OpenAI-compatible API | your own base URL, ending at `/v1` |

Two things bite here, both handled for you:

- **The base URL must end at `/v1`.** The client appends `/chat/completions`, so
  `https://opencode.ai/zen/go` requests `…/zen/go/chat/completions` and 404s. Pasting a full
  endpoint is fine — a trailing `/chat/completions` is stripped. Note also that
  `https://opencode.ai/go/…` is a *website* route, not an API: it answers with an HTML 404
  page rather than an API error.
- **OpenCode Go requires a conversation id.** Orbital sends its own session id in
  `x-opencode-session` (Go answers `400 MissingSessionID` without it) and identifies itself
  with a `orbital-ide/<version>` user agent, as Go's client guidance asks.

When a provider call fails, the run is settled with a one-line diagnosis rather than the raw
response — status, the gateway's own reason, the hint for that status, and the URL that was
actually requested:

```
HTTP 404 — Not Found | opencode — that endpoint path does not exist — check
ORBITAL_LLM_BASE_URL — (requested https://opencode.ai/zen/go/chat/completions)
```

A dropped connection mid-response (`WinError 1236`, a reset TLS socket, a 502) is retried by
the graph rather than failing the phase: the stream had already started, so the SDK's own
`max_retries` cannot cover it. Permanent errors are not retried, and are not blamed on the
network.

### What a run costs

Every run logs one line, echoed into the app's **Logs** tab, so the profile stays visible:

```
phase build finished — 10 model calls · 1,511 chars out · 15 tool calls · 55.4s
```

Those figures are measured by Orbital itself — model turns counted from the graph stream,
characters counted from the tokens it forwarded. **Gateway-reported token usage is not used**:
it proved unreliable here, reporting figures like nine million input tokens for a single call.

Three deliberate choices keep the work down:

- **Per-phase context.** The orchestrator is sent only the artefacts its phase consumes (the
  plan when designing, plan and design when building, nothing when syncing), capped at 2.5 KB
  each. Sending every artefact to every call was the largest avoidable input cost.
- **Terse reports.** Specialists keep the closing report to six bullets, because every long
  report is replayed on each later turn of the same run.
- **Role-sized output ceilings.** The orchestrator gets a far smaller budget than a specialist.
  Treat this as a backstop: some gateways ignore it, and the OpenCode gateway does today.

Clients are built per role, and one Orbital session is one gateway conversation — so the
gateway's prompt cache applies across the phases of a run.

### Choosing a model, and seeing what it costs

The composer carries a **model picker** fed by `GET /api/models`, which reads the gateway's live
catalogue (37 models on OpenCode Go, plus 8 free ones on Zen) and falls back to a short static
list when the gateway is unreachable. The choice is remembered and sent with each run, so you
can put a cheap model on the plan and an expensive one on the build.

The nav bar shows a **usage gauge**: an estimate of the largest prompt sent so far against
`ORBITAL_CONTEXT_WINDOW`, with a popover breaking down model calls, tool calls, prompt and
completion characters and elapsed time. It accumulates across the session, so it answers "how
much have I used?" rather than "what did that last call cost?" — and it updates while a phase
is running, not just at the end.

### Settings, and the provider credential

The gear at the bottom of the left sidebar opens a **settings page** over the centre — smaller
than the window, not a takeover. It covers the model and endpoint (including the context window
and output ceiling), execution limits (command timeout, output ceiling, allowed roots), the
pipeline's auto-advance preference, panel-size reset, and a read-only runtime section showing
version, protocol, uptime and any missing binaries. Saving writes to `backend/.env`, so the
change outlives the process.

Beside it, the profile button manages the **model-provider credential** — deliberately not an
app account, because there is no account system and inventing one would be a lie. "Signed in"
means a key is stored for the endpoint; **Sign in** writes one, **Sign out** clears it. The
stored key is never read back to the UI, only reported as configured.

Because a key can be configured and still be refused, that row reports what the gateway said,
not merely that a key is present: **accepted by the gateway** once an authenticated call has
succeeded, **rejected by the gateway** with the provider's own words when one was refused, and
**configured, not verified yet** before anything has settled it. The verdict is never used to
block a run — it is a past observation, not a fact about the key now, and the key can be
replaced at any moment — it tells you where to look when a turn fails.

### What the agent knows about the machine

Each specialist's system prompt ends with an environment block generated at run time: the OS,
the workspace root, the shell `run_command` really uses (`cmd.exe /C` on Windows), and the
utilities that exist there. This is not decoration — without it the build phase reached for
`head` on Windows, exited 255, wrote no source files and lost the phase. Specialists are also
told to prefer the file tools (`read_file`, `list_directory`, `search_files`) over their shell
equivalents, which is both portable and cheaper.

## Run

**Browser (fastest loop).** Two terminals, both from the repository root:

```bash
npm run backend:dev     # FastAPI + LangGraph on 127.0.0.1:8765
npm run dev             # Vite on http://localhost:5173
```

`backend:dev` (`backend/dev.mjs`) runs `backend/orbital_backend` through the repository venv — it
must run with `backend/` as the working directory, and with the interpreter that holds
fastapi/langgraph, neither of which a bare `python -m orbital_backend` gives you.

It also mints the runtime's **auth token** and hands it to both sides: `ORBITAL_AUTH_TOKEN` for
the backend, and `VITE_ORBITAL_TOKEN` in `frontend/.env.local` for the dev server — see
[Security model](#security-model) for why the runtime refuses everything without it. Run
`backend:dev` first; Vite restarts itself when that file changes, so a dev server already running
picks the token up.

Then open <http://localhost:5173>: the launcher appears, listing the projects you have already
made, with a form to create another. Pick one to open the IDE, or create the first with
**Choose…** for its parent folder plus a name (a description is optional) — the folder is
`<parent>/<name>`, created if it does not exist yet. See
[Projects and the launcher](#projects-and-the-launcher).

Sanity check that the runtime came up — every request needs the token, including this one:

```bash
# The same value is on the backend's ORBITAL_BACKEND_READY line, and in the desktop app it comes
# from the Tauri host instead.
TOKEN=$(grep -h '^VITE_ORBITAL_TOKEN=' frontend/.env.local | cut -d= -f2)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/api/health
# {"status":"ok",...,"llmConfigured":true,...}
```

**Desktop build.** Needs a Rust toolchain plus the platform Tauri prerequisites:

```bash
npm run backend:build   # PyInstaller → src-tauri/binaries/orbital-backend-<triple>
npm run tauri:dev       # or: npm run tauri:build
```

In `tauri dev` the host ignores the bundled binary and spawns the backend from
`backend/` with the venv interpreter, so `backend/` and `.venv` must exist. The host picks a
free port, starts the process, waits for the `ORBITAL_BACKEND_READY port=<n>` line on its
stdout, and only then reports ready — the frontend asks the host for the base URL rather
than assuming a port.

## Configuration

Everything is prefixed `ORBITAL_` and read from the process environment or `.env`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORBITAL_LLM_MODEL` | `deepseek-v4-flash` | model id, shared by all agents |
| `ORBITAL_LLM_BASE_URL` | `https://opencode.ai/zen/go/v1` | OpenAI-compatible base URL — must end at `/v1`, since the client appends `/chat/completions` |
| `ORBITAL_LLM_API_KEY` | *(empty)* | required to run agents |
| `ORBITAL_LLM_MAX_TOKENS` | `8000` | output ceiling per specialist turn; `0` disables it |
| `ORBITAL_CONTEXT_WINDOW` | `128000` | the window the context gauge measures against — the gateway publishes no sizes, so set it to match the model you pick |
| `ORBITAL_HOST` / `ORBITAL_PORT` | `127.0.0.1` / `8765` | bind address (`0` picks a free port) |
| `ORBITAL_AUTH_TOKEN` | *(empty)* | the secret every request and socket has to carry. Set by `npm run backend:dev` and read off the readiness line by the Tauri host; set it yourself only to make a bare `python -m orbital_backend` reachable |
| `ORBITAL_LOG_LEVEL` | `info` | uvicorn/backend log level |
| `ORBITAL_COMMAND_TIMEOUT` | `600` | seconds before a command's process tree is killed |
| `ORBITAL_MAX_OUTPUT_BYTES` | `262144` | stdout+stderr captured before truncation |
| `ORBITAL_ALLOWED_ROOTS` | *(empty)* | extra roots tools may touch; JSON array, comma list or single path. Empty = the open project only |

## Projects and the launcher

Orbital opens on a **launcher**, not on an empty IDE: the five-phase pipeline needs a project to
act on, so the first thing the window offers is the projects themselves. Picking one binds it as
the workspace and swaps in the IDE — same window, no restart — and the project name in the title
bar is the way back to the list, which is how you switch projects.

It is laid out like a file browser, because that is the job:

- **The bar across the top is the launcher's own**, and the app's only one while it is showing:
  the Orbital mark on the left, then the count, the search over names, descriptions and paths, the
  sort (last opened, name, date created), the grid/list toggle and **New project**. The IDE's title
  bar appears only once a project is open, because its controls — File, Search, Terminal, Help,
  the panel toggles, the context meter — all act on a workspace that does not exist yet.
- **The rail** narrows the list to *all / recent / favourites / this week / earlier* with live
  counts, and holds the app-level buttons that would otherwise have nowhere to live: **Learn**,
  **Settings** and the provider credential (**Account**).
- **The cards** carry a monogram thumbnail on one of the pipeline's hues, the name, the
  description, the folder path and when it was last opened, with a star when it is a favourite.
  There is no preview image: the runtime has no per-project preview to draw, and a placeholder
  that pretended to be one would be a lie the first time you looked at it.

**Right-click a project** (or use the control that appears on hover — both render the same list)
for its actions: open, edit the name and description, add or remove a favourite, *remove from
recent*, and delete. Removing a project from the list is deliberately **not** in this menu — one
misclick next to a harmless-looking entry should not lose a project, so that choice lives in the
dialog where both outcomes are written out. These are the ones that write something:

| Action | What it changes |
| --- | --- |
| Edit name and description | Orbital's own record. The folder on disk keeps its name. |
| Remove from recent | Forgets the opening, so the project leaves the recent windows and shows as *Not opened yet*. The entry stays. |
| Delete project… | The only place a project can leave the list. The dialog spells out both outcomes: **Delete project and files** removes the entry and the folder with everything in it, while **Remove from list instead** drops the registry entry and touches nothing on disk. The path is printed in full first. |

Deleting asks the runtime to refuse outright if the path is a drive root, the home directory, the
state directory or the Orbital checkout itself — the guard applies to the deletion only, so an
entry for any of those can still be cleared from the list. **Learn** opens the documentation the
runtime serves (`GET /api/docs`: the repository's README, or a built-in guide when the runtime has
no checkout beside it), which is why the help works with no network.

Going back is the **Projects** entry in the IDE's nav, or the project name beside it — both
return to the list, which is how you switch projects.

Creating one asks for four things, in a dialog: the **parent directory** (the OS chooser, or a
pasted path), a **name**, an optional **description**, and an optional **Git repository**. The
project folder is `<parent>/<name>`; it is created if it does not exist and reused if it does.

Give it a repository and the dialog asks for a **branching strategy** in the same window — the
three models are listed with the branches each one uses, so the choice is made with the branch
layout in front of you. The two travel together or not at all: no repository, no strategy question;
a repository without a strategy is refused, because "commit where?" is the one thing the build
phase must not have to guess. Both can be changed later from **Edit project…**. Creating a folder
that is already in the list returns that entry instead of duplicating it.

The list is one JSON file, not a database: `<state dir>/projects.json`, where the state directory
is `ORBITAL_STATE_DIR` or the per-user data directory (`%APPDATA%/Orbital` on Windows,
`~/Library/Application Support/Orbital` on macOS, `~/.local/share/orbital` elsewhere). It holds
`id`, `name`, `path`, `description`, `favourite`, `createdAt` and `lastOpenedAt` — ordered by the
last of those, with `0` meaning "never opened" — and it is written atomically, so a crash
mid-write cannot truncate it. It is a list of paths and the little Orbital remembers about them:
readable, editable and deletable by hand.

Opening a folder that is not in the list — from the File menu, say — adds it, because a folder the
user opened is a project to them, and a launcher that forgets it on the next start is worse than a
list that holds something they opened once.

One consequence worth knowing: the packaged desktop app hands the backend a single allowed root
(its own data directory) as a containment measure, so the directories the user opens are granted
as workspace roots for that process — creating a project here, or picking a folder from the File
menu, is what makes it reachable to the tools. The grant is per opened directory: a sibling the
user has not opened is still refused, and the containment checks inside a workspace (traversal,
symlink escapes) are unchanged.

## API

REST, all under `/api`: `health`, `phases`, `config` (GET/PUT), `models`, `docs`,
`branch-strategies`,
`projects` (GET/POST), `projects/{id}` (PATCH/DELETE), `project`, `project/open`, `project/tree`,
`files/content` (GET/PUT), `files` (DELETE), `files/search`, `git/status`, `git/init`,
`git/commit`, `git/push`, `terminal/exec`, `agents/run`, `agents/chat`, `agents/cancel`,
`agents/session/{id}`, `sessions`, `system/pick-folder`.

- `GET /api/files/search?q=&limit=` backs the nav's search bar. The query is matched
  **literally** — typing `add(` searches for those characters rather than raising a regex
  error — and it runs the same scan as the agent's `search_files` tool, so the user and the
  model see identical hits under identical ignore rules.
- `PUT /api/config` is what the settings page saves with. It rewrites `backend/.env` in place
  (comments and unrelated keys preserved) and applies the values to the running process, so
  every setting except the bind address takes effect on the next run without a restart. An
  empty `apiKey` is the explicit sign-out, and the key is never read back.

### Choosing a folder

Both builds put up a real OS folder chooser; neither asks the user to type a path.

- **Desktop** — the Tauri dialog plugin, modal to the app window.
- **Browser** — no web API can return an absolute path (`showDirectoryPicker()` returns an
  opaque handle by design, and `<input webkitdirectory>` only exposes `C:\fakepath\…`), so
  `POST /api/system/pick-folder` asks the local Python runtime to show the dialog. It is on
  the same machine as the user, so the path it returns is one the workspace layer can use.

The endpoint answers `{path, available, reason}`. `available: false` means this runtime
cannot show a dialog (no Tk, or a frozen sidecar) and the UI should fall back to the manual
path field; `reason` explains a null path that was not a plain cancel. Only one dialog may
be open at a time — a second request is refused rather than queued behind a modal window
nobody is looking at. The dialog runs on a worker thread, so `/api/health` keeps answering
(measured: 86 ms) while it is open.

One WebSocket at `/ws` carries every frame as
`{ v, type, sessionId, seq, ts, payload }`:

- *client → server*: `ping`, `subscribe`, `agent.run`, `agent.chat`, `agent.cancel`,
  `agent.approve`, `terminal.exec`, `terminal.cancel`, `files.watch`
  (both agent frames carry `attachments`, `reasoningEffort`, `capabilities` and `permission`)
- *server → client*: `session.state`, `phase.changed`, `agent.node`, `agent.message.start`,
  `agent.token`, `agent.message.end`, `agent.tool_call`, `agent.tool_result`, `agent.error`,
  `agent.done`, `agent.command_request`, `agent.todos`, `approval.resolved`,
  `terminal.output`, `terminal.exit`, `file.changed`, `artifact.updated`, `usage.updated`,
  `log`, `error`, `pong`

Every frame carries two counters. `seq` is monotonic for the whole process and orders all of its
output; `sessionSeq` counts only that session's frames, and it is the one the client checks — a
client is only ever sent its own session's frames, so `seq` moves under it whenever another window
or session is busy, and comparing it reported loss that had not happened. A real gap means frames
for this session were emitted while this socket was not receiving, and the client says so and
resynchronises by re-requesting the session rather than drifting.

The resync restores what the session state carries: the transcript, the artefacts, the phase
statuses, usage, and any command still held for a decision. It does not replay the tool-call
inspector rows or the terminal transcript for the missed window — those exist only as frames. `session.state` carries the whole state a
client needs to recover — phase statuses, artefacts, transcript and any command still held
for a decision — so a reconnect loses nothing it cannot re-establish.

## Security model

The agent runs on the user's machine with the user's privileges, so containment is explicit:

- **One workspace root.** Every file path from a tool or a request goes through
  `Workspace.resolve`, which rejects absolute paths, `..` traversal and symlink escapes, and
  enforces `ORBITAL_ALLOWED_ROOTS` when set.
- **No shell interpolation of user text.** Paths and remote names are quoted with
  `list2cmdline`/`shlex.quote`; commit messages are piped on stdin, so `%VAR%` and quotes
  survive `cmd.exe`.
- **Commands are held for approval.** A shell command is emitted to the UI and the tool awaits
  the answer; a denial is returned to the agent as a refusal, and an unanswered request times
  out into a denial rather than running. Blanket permission is per session and cleared when the
  run ends.
- **Bounded execution.** Per-command timeout and output ceiling; the whole process tree is
  killed on timeout or cancel. A run is capped at a tool-call budget.
- **The runtime authenticates its host.** Loopback is not a boundary: any page the user has open
  can reach `127.0.0.1`, and on a shared machine so can every other local account. So every
  request needs `Authorization: Bearer $ORBITAL_AUTH_TOKEN` and every socket has to present the
  same token in its first frame within five seconds — the token is a frame rather than a query
  parameter because a query string is written to every access log. With no token configured the
  runtime mints one and prints it on its readiness line, which is how the packaged app gets it
  without baking it into a bundle; a bare `python -m orbital_backend` therefore answers nobody
  until that token is passed on, and says so once at startup. A refusal never says whether a
  token was configured.
- **Sockets check their origin.** A browser does not apply CORS to a WebSocket handshake, so the
  handshake itself is refused unless its `Origin` is one the app can legitimately have (loopback
  or the Tauri webview); a missing `Origin` is allowed, because that is a non-browser local
  client and the token is what gates it.
- **One home for the credential.** A key lives in `providers.json`, written readable only by the
  user's account; `PUT /api/config` refuses an `apiKey` outright, and the first start that
  imports the old `backend/.env` key into a profile blanks it there. A key is also refused for a
  cloud profile pointed at a loopback, private or link-local address, and a provider's own
  refusal text is stripped of the key before it is stored, served from `/api/health` or logged.
- **CORS** is limited to the Tauri webview origins and the Vite dev server.

## Tests

```bash
.venv/Scripts/python.exe -m pytest backend/tests -q
npm run typecheck
npm run build
```

Backend coverage: workspace containment (traversal, symlink, allowed roots), the REST
surface, the tool layer, and the agent graph driven end to end by a scripted model —
including phase advancement across all five phases, tool-call frame pairing, and the
missing-key / missing-folder failure paths.

## Deliberate choices and known limits

- **The Tauri Rust host is written but not compiled** in this repository's working state —
  no Rust toolchain was available. `src-tauri/src/*` and the capability/config files are
  reviewed by hand only; `npm run tauri:dev` needs `rustup` plus the platform Tauri
  prerequisites first. The frontend and the whole Python runtime are verified.
- **chokidar → `watchfiles`.** The task named chokidar for file watching, but chokidar is a
  Node library and cannot run inside the Python sidecar. `watchfiles` is the equivalent
  production watcher (the one `uvicorn --reload` uses) and is what `services/watcher.py` drives.
- **The terminal is not a PTY.** xterm.js renders the live output stream and the panel
  assembles typed lines itself; commands run as request/response with streaming output,
  cancellation and timeouts. There is no interactive TTY (no `vim`, no password prompts).
- **Monaco is bundled, not fetched.** `@monaco-editor/react` fetches the editor from a CDN by
  default, which breaks offline use and the app's own CSP; `frontend/src/lib/monaco.ts` points
  the loader at the bundled package and serves the language workers from the bundle.
- **In `npm run dev`, Vite's HMR (and React's double-invoked effects) can double-instantiate
  Monaco or xterm** after a hot update, which logs
  `Cannot read properties of undefined (reading 'dimensions')` — from Monaco's editor service
  or xterm's viewport — and can leave the editor or terminal pane blank until the page is
  reloaded. It is a dev-server artifact, not a product bug: the
  production build mounts Monaco once and renders cleanly (verified — 40 lines, no console
  errors). Reload the page if an open editor goes blank while you are editing frontend code.
- **A discussion turn has its own output ceiling** (`DISCUSSION_MAX_TOKENS`), well below the
  specialist default. A specialist writing a file needs room; an agent answering "hey" does not,
  and with the larger ceiling it answered with a complete plan. The prompt asks for a
  conversational reply; the ceiling stops a runaway one.
- **Dark theme only.** The design is a dark industrial IDE surface by intent; there is no
  light variant.
- `node_modules`, `dist`, `.git` and friends appear in the workspace tree as dimmed,
  non-expandable nodes rather than being hidden.
