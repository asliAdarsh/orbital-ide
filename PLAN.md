# Orbital — build plan

The source of truth for what we are building and where it stands. Edit this file freely; I work
from it. `README.md` is the architecture reference (how the pieces fit), this is the roadmap (what
is done, what is next, and what is waiting on you).

Status: **All five phases are implemented and verified end to end, including the local-runtime
security hole the review found. Nothing is committed** — you chose to hold everything in the working
tree until you have reviewed it, so `feat/auth-gate` and `feat/provider-profiles` still point at the
last pushed commit and every phase's changes sit uncommitted side by side. The file-to-phase map for
that review is at the end of this file.

---

## The decisions that changed the original brief

1. **Accounts are real and enforced.** A Firebase account is required before the IDE opens. There
   is no anonymous mode. Sign-in gates the app; the backend's run identity is the account's `uid`.
2. **The provider credential is not the account.** Signing in identifies the person. The model
   credential is a separate thing the user configures — bring-your-own-key (OpenAI, Claude, Gemini,
   Grok, DeepSeek, OpenCode Go, Zen, Vercel, or a local model) or an Orbital key.
3. **Anything that can reach a provider key lives behind a gateway, not in the app.** A desktop app
   and a Fabrica-hosted service ship their source; a key compiled into either can be extracted. So
   the Orbital key is held server-side, and the app only ever sees a token for it. This is why the
   gateway (Phase 4) exists at all, and why Firebase Functions is the deployment target rather than
   a convenience.
4. **Local is a first-class mode.** Phases run against the local Python runtime with a local
   workspace and a locally held key. The account adds sync and the Orbital key; it is not a
   requirement for the app to function.
5. **One credential at a time.** No parallel fan-out of provider keys. The orchestrator works for
   everyone on one active provider; the local runtime uses whatever the user activated.

---

## Phase 1 — Account and sign-in (Firebase Auth) — **done, verified**

What shipped: `frontend/src/lib/firebase.ts` (initialises from `VITE_FIREBASE_*`, refuses to
initialise and says exactly which values are missing), `hooks/useAuth.ts` (email/password, Google,
password reset, sign-out), `components/auth/LoginPage.tsx` (sign in / create account, friendly error
wording, a visible notice when the emulator is running), an auth gate in `App.tsx` (no IDE, and no
agent socket, before sign-in), the account menu showing the signed-in address with Sign out, and
`firestore.rules` (deny by default; a user reaches only their own document).

Verified against the Firebase emulator suite on this machine (auth 9099, Firestore 8080):

| Check | Result |
| --- | --- |
| Create an account | shell opened; account exists in the emulator |
| Run identity | backend session id was the Firebase `uid`, not a local id |
| Reload while signed in | stays signed in |
| Account menu | shows the signed-in address, Sign out works |
| Sign out | returns to the sign-in page; the IDE is not reachable |
| Wrong password | "Wrong email or password." (never a raw `auth/…` code) |
| Firestore rules | owner 200; another signed-in user 403; anonymous 403; cross-write 403 |
| Missing configuration | names the missing variables instead of failing at import |

## Phase 2 — Provider profiles — **done, verified**

What shipped: `services/providers.py` + `routes/providers.py` — a list of provider profiles the user
creates and activates, stored beside `projects.json` in a file restricted to the current user. The
active profile is what every run talks to. `GET /api/providers` never returns a key (only
`apiKeySet` and a last-four hint). `POST /api/providers/{id}/test` reports the endpoint's own words.
An existing `.env` credential is migrated into a profile once, on first load.

Verified live: the `.env` credential migrated into an active profile (`opencode.ai`,
`deepseek-v4.1-flash`, hint `wPPj` — never the key); a deliberately broken profile was activated and
a run failed with that endpoint's error (`ConnectError from http://127.0.0.1:9/v1/models`), then a
switch back to the working profile made the same run succeed. 262 backend tests pass; the frontend
typechecks and builds.

## Phase 3 — Onboarding and settings UI — **done, verified**

What shipped: a first-run screen (`components/onboarding/ProviderSetup.tsx`) that lists the presets
with the host, model and whether a key is needed — all read from the backend rather than hardcoded —
lets the endpoint and model be edited, hides the key field for key-less kinds, and states plainly
that the key is stored on this machine and sent only to that provider's own endpoint. Settings gained
`components/settings/ProvidersPanel.tsx` (activate, edit, test, delete, clear key, with the test's
verdict shown inline and a warning when a key is re-pointed at a different host), and the old
key/endpoint fields in the settings dialog are gone — there is exactly one place to enter a key now.
`hooks/useProviders.ts` mirrors `useAuth`'s shape. The gate order is boot → sign-in → provider setup
→ IDE, with a "Later" escape remembered per account, because a user with no key can still browse and
use the terminal.

Verified in a real browser against the emulator build: with no provider configured, signing in lands
on the setup screen; choosing OpenCode Go, pasting a key and pressing Save and test creates and
activates the profile and opens the app; a real chat turn then returned `ready` from
`deepseek-v4.1-flash` with the usage meter reading `1.9K/128K · 1x`, and `echo orbital-terminal-ok`
in the integrated terminal returned `exit 0 · 65ms` — both over the token-authenticated socket.

## Phase 4 — The Orbital gateway — **done and verified locally, not deployed**

`gateway/` is a Firebase Function (TypeScript, Node 20) serving an OpenAI-compatible surface:
`GET /health`, `GET /v1/models`, `POST /v1/chat/completions` with SSE pass-through. It verifies the
caller's Firebase ID token, checks entitlement in `users/{uid}` (suspended → 403, allowance spent →
402 naming the reset), holds the upstream key in Secret Manager (`ORBITAL_UPSTREAM_API_KEY`, one
`defineSecret` binding, the same environment read in the emulator, tests and production), redacts that
key out of anything it quotes, records tokens against the account with the Admin SDK as best-effort
bookkeeping that can never fail a completion, and refuses a model outside its catalogue by name rather
than substituting one. 23 tests pass here, including the rules tests that prove a client cannot write
or delete anything an entitlement is read from.

Not done, and deliberately so: the deployment. Enabling Blaze, setting the secret and deploying is
your call; `gateway/README.md` lists the steps. The client side is done: an `orbital` provider kind
(the first preset, with no key to paste) whose base URL the app derives from the Firebase project id —
the emulator URL when the emulator is in use — and whose "key" is the signed-in user's ID token, kept
current by `useOrbitalProvider` through `onIdTokenChanged` and cleared on sign-out so a run fails with
the gateway's own 401 rather than a stale credential being used.

Verified end to end here: with the gateway running in the functions emulator, the app created the
Orbital profile itself (Settings read "Runs use Orbital · deepseek-v4-flash at 127.0.0.1:5001", and
the runtime row read "accepted by the gateway"), a chat turn came back answered, and the gateway's own
records in Firestore prove it served that turn rather than the app going round it — two usage entries
totalling the 5826 tokens billed to that account, the newer one the 76-token completion just made.

## Phase 5 — Sync and shipping — **done, verified**

Each project the runtime knows becomes one document, `users/{uid}/projects/{projectId}`, where the id
is a digest of the folder path — so the same project is one document on every machine, and two open
windows cannot each make their own copy. A document holds the title, the path, the last phase and
`updatedAt`, plus up to three artefacts (`plan`, `agents`, `report`) each capped at 64 KB. A file over
the cap is **skipped with a visible reason, never truncated**. The rules allow only the owner, only
the five fields, only those three artefact keys, only digest-shaped ids, and nothing else in the tree
is reachable. The dashboard gained a sync panel ("who is signed in, how many projects are synced,
Sync now, last result") and lists a project that is on the account but not on this machine as
synced-but-not-local, with no open affordance. Provider keys never sync — only labels, URLs and model
names, as decided.

Verified here: `npx tsc --noEmit` clean; the 10 rules tests pass run as a signed-in client; the panel
in the live app reports its account and "3 projects synced · just now"; reading the emulator's
Firestore shows the documents themselves — one project carrying all three artefacts (152/135/95 bytes)
and another carrying only `agents`, because its plan was over the cap and was skipped rather than
truncated.

Repo pushing (product step 5: sync the finished repository to a remote) already has its git tooling;
what this phase adds is the account-scoped record of it.

**Keys, decided.** Bring-your-own keys stay on the machine that entered them — the local credential
file, never a document, never the network except to the provider's own endpoint. The Orbital key is
account-scoped: the gateway holds it, and a second machine signs in and works with no key material
reaching the client at all. Profiles sync as labels, URLs and model names.

---

## Security — what the review found (and what is being done)

A review of Phases 1 and 2 found one thing that matters more than everything else in them: **the
account gate protected the window, not the runtime.** The Python runtime listens on loopback and
authenticated nobody, so `GET /api/sessions` returned the account's session and its messages,
`/api/files/content` returned workspace files, and — the part that decides this — the WebSocket
accepted any client and `terminal.exec` reaches a shell. CORS does not cover WebSocket handshakes,
so any web page open while Orbital runs could have driven it, and on a shared machine any other
local account could. That is arbitrary command execution as the person running Orbital, and it made
"you must sign in" a statement about a React tree.

Fixed, and verified against a running runtime: the sidecar mints a token at startup, prints it on the
readiness line, and requires it on every route and on the WebSocket's first frame (not in a URL, where
logs would keep it); the handshake also refuses an Origin that is not the app's. The runtime fails
closed if no token is configured, `dev.mjs` supplies one for development, and the packaged app gets it
from the host — never baked into the bundle. Alongside it: the credential no longer lives in
`backend/.env` as well as the profile store, and a provider key cannot be sent to a private-range
address or echoed back through an endpoint's own error text.

The measurements, taken here: unauthenticated `/api/sessions`, `/api/providers`, `/api/health` and
`/api/files/content` all return 401 where they previously returned data (including the live key's last
four characters); the same calls with the token return 200; a wrong token is 401; a WebSocket
handshake carrying `Origin: https://evil.example` is refused with HTTP 403 before a single frame; with
the token and no Origin the socket opens and answers a ping; with no auth frame or a wrong token it
closes 1008. The app itself then ran a real chat turn and a real shell command through that socket.

Being fixed now:
- **Sign-out leaves the agent socket open**, so a run started by one account keeps streaming into the
  next account's window (and keeps spending). The fix binds the socket and the session-scoped state to
  the account, cancels a run in flight and clears what the previous account left behind. It is in the
  tree now; the verification lands with it.
- **Usage and entitlement are not client-writable.** Done: the gateway writes them with the Admin SDK
  and the rules give the owner read-only access, which the rules tests prove by trying to credit
  tokens, lift a suspension and delete the document as a signed-in client.

The Rust half of the token change cannot be compiled on this machine (no Rust toolchain), so it is
written to be read, not built. The Python, TypeScript and dev-script halves are all verified here.

---

## What I need from you (Firebase console)

You can do these in any order; the app works today against the emulator without any of them.

1. **Project** — create it (or name an existing one). Note the project id.
2. **Authentication → Sign-in method** — enable **Email/Password** and **Google**.
3. **Project settings → General → Your apps** — register a **Web** app, and copy the config into
   `frontend/.env.local` (copy `frontend/.env.example` first). Six values: `apiKey`, `authDomain`,
   `projectId`, `appId`, plus `storageBucket` and `messagingSenderId` if shown. `VITE_FIREBASE_EMULATOR=0`.
4. **Authentication → Settings → Authorized domains** — add `localhost` (usually already there) and
   `tauri.localhost`, which is the origin the packaged Tauri app serves from.
5. **Firestore** — create the database in production mode, then deploy the rules already in this
   repo: `npx firebase deploy --only firestore:rules` (the CLI is installed; `firebase login` first).
6. **Functions (Blaze)** — required for Phase 4's deployment, not for building it. Say the word and
   I will do the deployment steps with you rather than describe them.
7. **Service account for the gateway** — a key file for the gateway's Firestore reads, or, better,
   deploy the gateway somewhere with Application Default Credentials so there is no key file at all.

## Standing rules

- Nothing is committed or pushed without your approval, per phase.
- This file is the plan; if it disagrees with the code, the code and this file get reconciled before
  the next phase starts.
- Local mode keeps working at every step: no phase makes a Firebase project mandatory to run Orbital.

---

## Round two — provider UX, real model lists, and credits

The owner used the app and reported it does not behave as intended, plus specified the flow properly.
Both causes were real defects in Phase 3:

- **No modal appeared.** The runtime silently migrated `ORBITAL_LLM_API_KEY` out of `backend/.env`
  into an active profile, so the app considered a provider already configured and skipped setup.
  Provider setup was also a **full-screen gate before the IDE** rather than a dialog over the
  dashboard.
- **The flow was thinner than specified.** There was no "connect, then list *that provider's*
  models" step, no per-provider model memory, no credit model, and no provider switch inside the
  chat composer.

What round two builds:

1. **A dismissible provider dialog over the dashboard**, opened when the account has no provider or
   has never confirmed setup *on this machine* (the confirmation is machine-local, like the keys
   themselves, so a second machine asks once too). "Later" leaves the IDE usable; the dialog is
   reopenable from the composer and from Settings.
2. **Connect, then list.** A profile gains the model list its provider served, kept with a source of
   `provider` or `preset`. A credential rejection is never confused with a provider that will not
   list models — OpenCode Go serves 36 models, its list carries no pricing or context length, and a
   malformed client (my own first probe) gets Cloudflare `1010`, which is not a bad key.
3. **Local servers as first-class presets.** LM Studio is installed here on 1234 with
   `google/gemma-4-e4b` loaded and answering real completions; Ollama is not installed and 11434 is
   free. The single `local` preset pointed at Ollama's port, so it was split into `ollama` and
   `lmstudio`, both keyless and both editable.
4. **Credits for Orbital**, server-side in the gateway: a 36-model catalogue with a per-**prompt**
   cost of 0.5 / 1 / 2, `free` at 30 credits a month, monthly reset on the 1st UTC applied lazily,
   nothing rolled over, and a 402 that names the cost and the refill instant. The catalogue carries
   a `paidOnly` flag so restricting models to a paid plan later is a data change, but every model is
   reachable today because no paid plan exists yet.
5. **A VS Code-like composer** — provider and model switchable inside the chat box, sent with the
   run as a per-run provider override so pinning costs no global mutation. The pin is remembered per
   account. Note honestly: the runtime's session identity is the account's uid, so "per
   conversation" is for now "per account, remembered" — the mechanism keys by conversation id the
   day conversations become first-class.

**Verified, round two.** Backend suite 300 tests; gateway suite 46 tests (typecheck clean on both).
Against the live provider: OpenCode Go connects and reports **36 models with `source: provider`**, and
LM Studio connects and reports its own two ids (one of which is an embedding model the UI hides).
A chat pinned to LM Studio answered from the local model **while the active profile stayed unchanged**,
and an unknown `providerId` was refused by name (400), as was an unknown profile on connect (404).
Through the gateway: `/v1/models` returns all 36 with a `credits_per_prompt`, `/v1/account` reports
the free plan at 30 credits with `resets_at` on the 1st of the next month UTC, a real prompt on a
0.5-credit model **charged exactly 0.5**, a 2-credit model with 1 credit left returned **402** naming
the cost and the refill instant, and a reset instant in the past zeroed usage once and stayed zero on
the second read.

Two defects were found and fixed by verifying rather than reading. The first was mine to catch: the
gateway forwarded OpenCode's `x-opencode-session` header **only if the caller sent one**, so any
ordinary OpenAI-compatible client got the upstream's own complaint quoted back ("Request is missing
x-opencode-session") instead of a completion — the app escaped it only because its runtime happens to
send the header. It now always supplies one, sanitized and bounded, derived from the account when the
caller has none. The second: the provider dialog trigger was keyed on "no profiles exist", which is
exactly why a migrated `.env` key silenced it; it is keyed on a machine-local confirmation now.

Finally, through the app's own path end to end: a chat **pinned to Orbital** in the runtime came back
with the model's answer, and the account's credits went **30 → 29.5** — exactly the 0.5 that model
costs. In the UI, the dialog's Orbital tab shows the free plan, "30 of 30 credits left", and every
available model with its per-prompt price, with no key field anywhere.

**A provider that refuses the whole account.** The owner connected a Vercel AI Gateway key and every
run failed. Reproduced directly with his key: **403 for every model**, including mainstream ones, and
the model he picked (`stealth/pixel-canary`) is listed by Vercel at $0.00/1M in and out — so neither
the key nor the model was at fault. Vercel refuses to forward anything until the team has a payment
card on file ("AI Gateway requires a valid credit card on file … to unlock your free credits"), and
its free tier is a subset of the catalogue. Nothing in Orbital can or should work around that.

What *was* our fault, and is fixed: the app appended its generic 403 hint — "the endpoint refused the
key — check its permissions" — right after Vercel's own explanation, which is false there and sent him
looking at his key. A provider that explains itself now speaks alone, and the hint is kept only when
there is nothing else to go on. And `connect` now proves the account can actually make a request
(one minimal completion with the profile's own model) instead of only listing models, so this is
reported at connect time: Vercel answers `ok: false` with its own words and the link that fixes it,
while a slow local endpoint that simply does not answer in time is reported as *unproven* rather than
accused. The link is no longer truncated on the way to the dialog.

---

## Round three — chat sessions, slash commands, and mentions

The owner asked for VS Code-like session management per chat, slash shortcuts in the chat box
(`/model`, `/explain`, `/skill`, `/agents`, and new ones like `/pause` and `/ask`), and `@`-mentioning
a file or a folder.

Reconnaissance found the two things that make this more than UI: **sessions are in-memory only**
(`services/sessions.py` holds a `dict`, so a finished exchange dies with the backend), and **the
session id is the account's uid**, so every user has exactly one conversation. Both change here.

What is being built:

1. **Chats that persist.** A chat carries an id, a title, the workspace it belongs to, a phase, a
   pinned provider and model, timestamps, a message count and its run status. It lives in
   `<state dir>/chats/` — an index plus one file per transcript, written atomically, read
   tolerantly, and **restricted to the current user**, because a transcript contains the user's code
   and whatever a tool printed. `GET /api/chats/{id}` is what "refresh" fetches; the title comes from
   the first user message until renamed.
2. **The chat is the session.** The id the runtime keys runs by becomes the chat id, so a conversation
   is a first-class thing rather than a side effect of being signed in.
3. **Run control.** `agent.pause` / `agent.resume` stop and continue a run at a **step boundary** —
   never mid-token, and the state survives, so resuming continues rather than restarting. `agent.ask`
   answers a question from the model with the chat's context **without touching the transcript or the
   run**, which is the point: you can ask a clarifying question while the agent keeps working.
4. **Skills.** Markdown instruction packs read from `<workspace>/.orbital/skills/` and the user's state
   dir, listed and read but never written or executed by the app — `/skill` composes one into a prompt.
5. **The composer.** A slash palette with each command's description, and an `@` picker for files and
   folders that become chips and travel as the `attachments` the backend already embeds.

**Verified.** 350 backend tests (up from 300), frontend typecheck clean, gateway suite green.
*Chats:* created, listed, renamed, refreshed, cleared and deleted over the API, and — the point of the
whole exercise — a transcript **survived a real backend restart** with its title, its workspace and
both messages intact; the store's files are owner-only (the ACL on `index.json` names the user and
nothing else). In a real browser the sessions panel switched between chats with the socket's subscribe
id changing, and rename and refresh both round-tripped to the server (renaming on the server with curl
and pressing Refresh showed the server's title). *Attachments:* a file mention was answered with
`orbital` — the `name` field of the attached `package.json`, knowable only if the file reached the
model — and a folder mention listed all thirteen files of `gateway/src`. *Run control,* by my own
probe rather than the slice's: a build-phase run reported `running`, then `paused` on my frame, held
still for six seconds with its message count unchanged, then `resume` carried the same run to `idle`
with the reply appended; the socket streamed `idle, running, paused, paused, running, running, idle`.
An ask answered while a run was in flight, left the run's status and message ids untouched, and was
absent from the transcript. In the browser, `/model`, `/agents` and `/help` made **zero** network
requests, `/skill` listed a skill and inserted its body, and `@` produced chips that left the composer
as `attachments: ["agent", "index.html"]`.

Not exercised: the prompt-composing commands (`/explain`, `/new`, `/clear`, `/rename`, `/stop`) beyond
rendering in the palette and the thin wrappers whose APIs are verified above, and no skill exists on
this machine yet, so `/skill` lists nothing until one is added.

**A namespace bug in the composer pin, found while driving the UI, and fixed.** A provider or model
choice is stored per account, but `bindAccount` read — and `setProviderId` wrote — the key for the
*empty* uid, the one that stands for "no account yet". Anything pinned before sign-in settled
therefore sat in the namespace the next account reads as its own. Both directions now treat "no
account" as no pin and keep it in memory until there is someone to attribute it to.

The same session did surface something the code was not wrong about: the composer showed a local
provider that was not running, because that profile was genuinely the **active** one — left there by
an earlier UI test — and the composer correctly falls back to the active profile when no pin exists.
The lesson is about the state I left behind, not the fallback: a dead active provider makes every run
fail with nothing on screen saying why, which is worth its own guard later.

---

## What is uncommitted, and which phase it belongs to

Everything below is in the working tree, on `feat/provider-profiles`, uncommitted. `*` means the file
is new.

**Phase 1 — the auth gate.** `frontend/src/lib/firebase.ts`*, `hooks/useAuth.ts`*,
`components/auth/LoginPage.tsx`*, `hooks/useBackendBoot.ts`, `components/panels/ProfilePopover.tsx`,
`App.tsx`, `frontend/package.json` + `package-lock.json` (the `firebase` dependency),
`frontend/.env.example`*, `.gitignore`, `firebase.json`*, `.firebaserc`*, `firestore.rules`*.

**Phase 2 — provider profiles.** `backend/orbital_backend/services/providers.py`*,
`routes/providers.py`*, `models.py`, `agents/llm.py`, `config.py`, `main.py`, `routes/__init__.py`,
`backend/.env.example`, `backend/tests/test_providers.py`*.

**Phase 3 — onboarding and settings.** `frontend/src/lib/providers.ts`*,
`hooks/useProviders.ts`*, `components/onboarding/ProviderSetup.tsx`*,
`components/settings/ProvidersPanel.tsx`*, `components/panels/SettingsDialog.tsx`, `App.tsx`,
`components/panels/ProfilePopover.tsx`.

**Security hardening (found by review, not in the original plan).**
`backend/orbital_backend/auth.py`*, `main.py`, `ws.py`, `__main__.py`, `config.py`, `models.py`,
`routes/system.py`, `services/settings_file.py`, `services/providers.py`, `agents/llm.py`,
`backend/tests/test_runtime_auth.py`*, `frontend/src/lib/api.ts`, `lib/ws.ts`, `lib/backend.ts`,
`hooks/useBackendBoot.ts`, `frontend/.env.example`, `src-tauri/src/**`, `dev.mjs`, `README.md`.

**Session lifecycle.** `frontend/src/hooks/useAgentSocket.ts`, `store/app-store.ts`, `App.tsx`.

**Phase 4 — the gateway and its client path.** `gateway/**`*, the `functions` block of
`firebase.json`, `firestore.rules`, `backend/orbital_backend/services/providers.py`, `models.py`,
`routes/providers.py`, `backend/tests/test_providers.py`, `frontend/src/lib/providers.ts`,
`hooks/useProviders.ts`, `hooks/useOrbitalProvider.ts`*,
`components/onboarding/ProviderSetup.tsx`, `components/settings/ProvidersPanel.tsx`.

**Phase 5 — sync.** `frontend/src/lib/firestore.ts`*, `hooks/useProjectSync.ts`*,
`components/dashboard/SyncPanel.tsx`*, `components/dashboard/SyncedProject.tsx`*,
`components/dashboard/Dashboard.tsx`, `firestore.rules`, `gateway/package.json`,
`gateway/test/projectSync.rules.test.ts`*.

Note for the split: eight files carry more than one phase's work — `App.tsx`,
`ProfilePopover.tsx`, `SettingsDialog.tsx`, `useBackendBoot.ts`, `models.py`,
`services/providers.py`, `providers.py`, `firestore.rules`. Committing phase by phase therefore needs
hunk-level staging for those; committing the account-and-provider work as one change does not. Your
call, and I will do either without touching the other phases.
