# The Orbital gateway

One Firebase Function (`orbital`) that lets a signed-in Orbital account run phases on the Orbital
key instead of bringing their own.

The reason it exists is that a desktop app ships its source: a key compiled into it can be extracted.
So the key lives here, and the client only ever presents proof of who it is. The client's existing
OpenAI-compatible code needs nothing new for this — a base URL and a token:

```
https://us-central1-<project>.cloudfunctions.net/orbital/v1
```

## Surface

| Route | Who may call it | What it answers |
| --- | --- | --- |
| `GET /health` | anyone | `{ "status": "ok", "version": "0.1.0" }` |
| `GET /v1/models` | a verified caller | the catalogue, OpenAI-shaped: `{ object: "list", data: [{ id, object: "model", owned_by, credits_per_prompt }] }`. Entries the caller's plan may not use are omitted |
| `GET /v1/account` | a verified caller | `{ plan, credits: { limit, used, remaining, resets_at } }`, with the lazy monthly reset already applied — the numbers a request would be checked against |
| `POST /v1/chat/completions` | a verified caller with entitlement | the upstream's response, streamed or not; one `credits_per_prompt` is charged for it |

Status codes, all with an OpenAI-shaped body (`{ "error": { "message", "type", "code" } }` — the
client reads `error.message` and shows it to a person):

| Status | `code` | When |
| --- | --- | --- |
| 400 | `model_required`, `model_not_found` | no `model`, or one the catalogue does not serve. The message names the allowed set; the request is never silently rewritten to another model |
| 400 | `invalid_body`, `invalid_json`, `invalid_request_error` | the body is not a JSON object, is not JSON at all, or the upstream refused it (`upstream_rejected_request`) |
| 401 | `unauthenticated`, `invalid_token` | no `Authorization: Bearer` header, or a token the Admin SDK would not verify |
| 402 | `allowance_exhausted` | the credits left are fewer than the model's `credits_per_prompt` (`type: insufficient_credits`), or `tokensUsed >= tokensLimit` (`type: insufficient_quota`). Either message says when the allowance comes back |
| 403 | `account_suspended`, `model_not_available_on_plan` | the account document says `disabled: true`, or the model is paid-only and the plan is not |
| 413 | `body_too_large` | the request body is over 4 MB |
| 429 | `too_many_concurrent_requests`, `upstream_rate_limited` | this instance already holds the per-account in-flight cap; or the upstream is rate limiting the gateway |
| 502 | `upstream_unreachable`, `upstream_failed`, `upstream_stream_interrupted`, `upstream_credential_refused` | the gateway's provider could not be reached, failed, or refused *the gateway's* credential |
| 500 | `upstream_key_missing`, `internal` | the deployment is missing its secret, or something threw |

The catalogue is the source of truth for what may be asked for: a request for anything else is a 400
naming what is served. Each entry carries the id the client asks for, the id the upstream is asked
for, what one prompt of it costs in credits, and whether it is paid-only — so adding an alias, a model
or a cost is a table edit rather than a change to the proxy. The ids are the upstream's 36 models
(`GET {upstream}/models`, checked 2026-09-28); the upstream reports **no pricing and no context
length**, which is why the cost of a model is a table in `src/config.ts` that Orbital maintains.

A prompt costs **0.5, 1 or 2 credits** depending on the model, and nothing else: the tiers are the
whole pricing model, and `credits_per_prompt` is exactly what a successful prompt deducts, whatever
the completion turns out to be. The free plan's 30 credits a month are therefore 60 prompts at `0.5`,
30 at `1` or 15 at `2`. A model marked `paidOnly` would be hidden from `/v1/models` for a plan that
does not include such models and refused with `model_not_available_on_plan`; **no model is marked
paid-only today**, because no paid plan exists yet and a locked door with no key behind it would make
a model unreachable.

### What crosses to the upstream, and what does not

The request body is forwarded **unchanged except `model`** — tools, `tool_choice`, `temperature`,
`max_tokens`, multi-turn arrays and anything else a client sends survive untouched, and the response
body (or SSE frames, including the terminating `data: [DONE]`) is relayed **byte for byte**.
`stream: false` works too.

`x-opencode-session` is forwarded: the client sets it for upstream routing and prompt-cache reuse.
Nothing else of the client's crosses over, and its `Authorization` header — an account token — never
does. The hop upstream is authenticated with the Orbital key, which is read in exactly one place
(`src/config.ts`) and reaches nothing else: not the client, not a log line, not an error body. Upstream
error text is quoted back only after the key has been redacted out of it, because an upstream that
echoes the credential it rejected would otherwise leak it through this gateway.

## The caller

`Authorization: Bearer <Firebase ID token>`, verified with `firebase-admin`'s `verifyIdToken(token,
true)`. The revocation check is on: an ID token lives for an hour, and an account disabled in the
meantime must not keep spending the Orbital key until it expires.

**Local development works against the emulator suite.** When `FIREBASE_AUTH_EMULATOR_HOST` is set the
Admin SDK verifies emulator-issued tokens, so the same code path runs locally, and the test suite
proves it: one test signs a user up against the auth emulator and calls the gateway with the token it
got back, and another disables that account and shows the same token being refused
(`auth/user-disabled`).

## Entitlement

Document `users/{uid}`:

```jsonc
{
  "plan": "free",              // defaults to `free` when the document does not say
  "creditsLimit": 30,          // optional: the plan's limit when absent, a per-account grant when present
  "creditsUsed": 12,
  "creditsResetAt": 1790985600, // epoch seconds; the 1st of the next month, UTC
  "tokensUsed": 1200,
  "tokensLimit": 50000,
  "disabled": false
}
```

Read by the gateway with the Admin SDK (which bypasses security rules by design), and readable by the
client. **A missing document means the default plan, and is allowed.** Three things stop a run:

- `disabled: true` → 403, telling the person their account is suspended.
- `tokensUsed >= tokensLimit` → 402, telling them the token allowance is used up and when it resets.
- fewer credits left than the model's `creditsPerPrompt` → 402 `insufficient_credits`, telling them
  what the model costs and when the credits refill.

Anything else is allowed; the gateway does not invent refusals it was not asked to make. Both 402s are
checked **before** the request is forwarded, so an account that cannot pay never spends the Orbital key.

**The free plan is 30 credits a month, and nothing rolls over.** The plan's terms live in `PLANS` in
`src/config.ts`: the limit, whether the allowance comes back monthly, and whether the plan may use
paid-only models. No paid plan is seeded — inventing its price is not this change's to make — but a
paid plan is a second entry in that table (its own `creditsLimit`, `monthlyRefill: false` so it is not
made to wait, `includesPaidOnlyModels: true`), which is the whole mechanism.

**The refill is lazy, on the first authenticated request past the instant.** There is no scheduled
function: whichever read or charge notices that `creditsResetAt` is absent or past writes
`creditsUsed = 0` and the next 1st of a month in the same commit, so the period is corrected the moment
anyone asks and a second read in the same period changes nothing. The refill is the calendar month in
UTC — the only reset the schema supports — so the refusal names the instant the allowance comes back
(`…refill on 1 November 2026 at 00:00 UTC (2026-11-01T00:00:00.000Z)`) rather than implying a rolling
window the gateway cannot compute.

## Accounting

After a non-streamed completion, and after a streamed one finishes, in one transaction:

```jsonc
// users/{uid}
{
  "tokensUsed": <incremented by the response's usage.total_tokens>,
  "creditsUsed": <this prompt's credits, added to whatever the period already held>,
  "creditsResetAt": <moved on, if the period ended mid-request>,
  "updatedAt": <server time>
}

// users/{uid}/usage/{auto-id}
{ "at": <server time>, "model": "deepseek-v4-flash", "promptTokens": 40, "completionTokens": 12, "totalTokens": 52, "credits": 0.5 }
```

The token figure is `usage.total_tokens` from the response when the upstream reports it. When it does
not, the gateway estimates: **four characters per token**, counted over the request's `messages` plus
`tools` (tool definitions are input tokens, and on an agent run they are not a rounding error) and
over the completion text it relayed. That rule of thumb over-counts JSON overhead and under-counts
dense tokens. It exists to police an allowance and to leave an auditable trail, not to bill anyone —
which is why the record carries the numbers and nothing else.

The credit figure is not estimated at all: it is the catalogue's `creditsPerPrompt` for the model the
prompt resolved to, charged once when the completion has been delivered — one prompt is one charge,
streamed or not, whatever the token count. **A request that failed charges nothing**, and a stream the
caller abandoned records nothing either: they received no completion, and a partial figure written as
if it were a finished one would be accounting that lies in the other direction. The charge and the
period's start are one transaction, so a prompt that lands just after the month turns is charged to the
month that is running rather than zeroed a moment later.

The write runs **after** the response is on its way: bookkeeping can never delay a completion, and a
failure is logged (`usage accounting failed`, with the account, the model and the token count — never
a prompt, a completion or a credential) and never turns a successful completion into an error.

## The key

- **Production**: `ORBITAL_UPSTREAM_API_KEY` is a `defineSecret` binding (`src/index.ts`), which the
  Cloud Functions runtime mounts into the instance's environment from Secret Manager. The value is
  never in the code, the repo or the client.
- **Emulator and tests**: the same variable, from `gateway/.env.local` (see `gateway/.env.example`) or
  from the test process's environment. The functions emulator loads `.env*` files from the functions
  source directory, so the one read — `process.env[ORBITAL_UPSTREAM_API_KEY]` — is the same path
  everywhere.

`ORBITAL_UPSTREAM_BASE_URL` defaults to `https://opencode.ai/zen/go/v1`. Local runs set it in
`gateway/.env.local` (point it at a stub while working on the proxy itself). In production the default
is what you want unless the upstream moves; overriding it means setting the variable on the deployed
function — v2 functions are Cloud Run services, so
`gcloud run services update orbital --region us-central1 --update-env-vars ORBITAL_UPSTREAM_BASE_URL=…`
— or declaring it as a `defineString` param and reading that instead.

## Abuse floor, honestly labelled

Two limits, both best-effort, neither a rate limit:

- **Per-account in-flight cap** (`MAX_IN_FLIGHT_PER_ACCOUNT = 4`): the counter lives in one instance's
  memory and Cloud Functions runs many instances, each with its own. It bounds what one instance will
  hold open for one account, which is what stops a runaway client from occupying every connection that
  instance has. It does not bound what an account can spend.
- **`max_tokens` clamp** (`MAX_TOKENS_CLAMP = 8192`): a request asking for more has it lowered, and the
  response says so in an `x-orbital-clamped-max-tokens` header rather than hiding it. Requests at or
  below the ceiling are forwarded untouched.

A durable, global limit needs shared state and a story for when that state is unavailable; that is a
later decision, and the code says so rather than pretending otherwise.

## What was tightened in `firestore.rules`

The client could previously read and write `users/{their uid}` outright. It can still read its own
document, and now it can write only display-level fields on it:

- `allow read: if isOwner()` — unchanged behaviour, now explicit.
- `allow create` / `allow update: if isOwner()` **and** the write touches only `displayName` or
  `photoURL`. A client can therefore no longer credit itself `tokensUsed` or `creditsUsed`, extend
  `tokensLimit` or `creditsLimit`, move its own `creditsResetAt`, set `plan`, or lift its own
  `disabled`.
- `allow delete: if false` — deleting the document would reset the account to the default plan, which
  is the escalation the field rules would otherwise leave open.
- `users/{uid}/usage/{record}` is covered by the deny-all rule at the end of the file, so the
  accounting trail is closed to clients (reads included).

The gateway is unaffected: it writes with the Admin SDK, which bypasses rules. Six rules tests publish
*this repository's* `firestore.rules` to the emulator and then act as a client, asserting the allowed
writes and each refusal above — one case per field, `creditsLimit`, `creditsUsed` and `creditsResetAt`
included.

## Running it locally

```bash
# 1. Dependencies (the gateway is its own package, not a workspace of the frontend)
cd gateway && npm install

# 2. Local configuration: copy the template and put a key in it
cp .env.example .env.local          # then edit .env.local

# 3. The emulator suite, from the repository root — auth and Firestore for identity and entitlement,
#    functions for the gateway itself
npx firebase emulators:start --only functions,auth,firestore

# The function is then at:
#   http://127.0.0.1:5001/<project-id>/us-central1/orbital/health
```

The app derives that origin itself — it is the project id from the client's own Firebase config plus
the pinned region — and stores `<origin>/v1` as the base URL of an `orbital` provider profile, so a
profile created against the emulator is
`http://127.0.0.1:5001/<project-id>/us-central1/orbital/v1`.

`firebase.json` sets `functions.runtime` to `nodejs20`, which is what the deployment must use. If your
local Node is newer, the emulator says so and runs on yours — the code is `target: ES2022` CommonJS and
runs on both.

If the emulator suite is already running for auth and Firestore (so its ports are taken), start only
the functions emulator and point it at the running ones:

```bash
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-orbital \
  npx firebase emulators:start --only functions
```

## Tests

```bash
cd gateway
npm test        # the five files in test/, via node --import tsx --test
npm run build   # tsc, into dist/
```

The files run one at a time (`--test-concurrency=1`). They share one emulator suite, and two of them
*publish* `firestore.rules` to it — a rules reload while another file is mid-request is how a run
turns into a fifty-second stall rather than a failure. Sequential costs ten seconds and removes it.

They need the emulator suite (**auth on 9099, Firestore on 8080**) — start it with
`npx firebase emulators:start --only auth,firestore` from the repository root. If it is not running,
the first assertion says so and names that command.

Nothing here calls the real upstream. The proxy tests start a stub HTTP server in the test process and
point the gateway at it, which is also how they check what the upstream received: the same body with
the catalogue's model, `x-opencode-session` forwarded, and the *gateway's* key on the `Authorization`
header rather than the caller's token.

What the suite proves, per assertion that would fail if the behaviour regressed:

- `/health` needs no credential and reports the version `package.json` ships.
- `/v1/models` is refused without a verified token, in the OpenAI error shape; with one, it returns the
  catalogue, each entry carrying its `credits_per_prompt`, and it omits a paid-only entry for a plan
  that may not use it (proved with a paid-only model and a paid plan injected into the tables for the
  length of that one test, since nothing is seeded paid-only).
- `/v1/account` reports `limit`, `used`, `remaining` and the `resets_at` instant, from the document it
  describes — and defaults a missing document to the free plan's full allowance.
- A token for an account disabled after it was issued is refused — i.e. the revocation check is on.
- An unauthenticated, a suspended, an over-allowance, an out-of-credits and an unknown-model request
  are each refused **before** the provider hears about it (the stub's call log stays empty), and the
  credits refusal names the model, what it costs and the day the allowance refills.
- A prompt whose remaining credits exactly cover it is still served — the check is `remaining <
  creditsPerPrompt`, not `remaining <= 0`.
- The catalogue's id-to-cost table is asserted against the tiers written out in the test, so a
  re-costed or mis-tiered model fails rather than silently charging a different number.
- A prompt charges exactly its model's cost once — non-streamed and streamed alike, whatever the token
  count — in `creditsUsed` and in the usage record's `credits`.
- A prompt whose upstream failed charges nothing: the next successful prompt's charge is checked to be
  exactly its own cost, not the sum.
- A month whose end has passed is zeroed on the first read, in the document (not only in the answer),
  with `resets_at` the 1st of the next month UTC; reading again does not zero usage recorded inside
  the new period.
- A streamed completion arrives byte for byte, `data: [DONE]` included, with a chunk boundary landing
  in the middle of a multi-byte character; a non-streamed one arrives with its JSON body intact.
- Tool definitions, `tool_choice`, `temperature` and multi-turn arrays survive the hop.
- `usage.total_tokens` is recorded against the right uid, in the account counter and in a usage record;
  a response with no `usage` is estimated from the prompt and the deltas that were relayed.
- The clamp applies, is reported in the header, and leaves smaller requests alone.
- The Orbital key is what authenticates the hop, and it appears in no response body — including the
  body of a refusal — where an upstream that echoes the credential it rejected is redacted.
- An upstream 401 becomes a 502 `upstream_credential_refused`, so a client never tells the user to
  re-enter a key they never entered.
- The per-account in-flight cap answers 429 and the capped request never leaves.
- **When the bookkeeping write cannot run at all** (the test terminates the Firestore client between
  the entitlement read and the write, using the stub to hold the answer so the timing is exact) the
  completion is still delivered with status 200, and the failure is logged with the account, the token
  count and no prompt, completion or token text.
- Six rules tests publish `firestore.rules` to the Firestore emulator and act as a client: reads of
  one's own document and of nobody else's, display-field writes allowed, and `tokensUsed`,
  `tokensLimit`, `creditsLimit`, `creditsUsed`, `creditsResetAt`, `disabled`, `plan`, `updatedAt`,
  document creation with account fields (credit fields included), deletion and the `usage`
  subcollection all refused.

## Not done yet

Nothing here has been deployed, and nothing in this directory has been run against a real Firebase
project. What a deployment would take:

1. A Firebase project on the **Blaze** plan (Cloud Functions with secrets is not free-tier).
2. `firebase login`, and the project id in `.firebaserc` instead of the `demo-orbital` emulator alias.
3. The secret: `npx firebase functions:secrets:set ORBITAL_UPSTREAM_API_KEY` (it prompts for the value;
   the value never enters this repository).
4. `npx firebase deploy --only functions:orbital` — the `predeploy` hook runs `npm run build` in
   `gateway/`.
5. `npx firebase deploy --only firestore:rules` for the tightened rules.
6. Whatever sets `ORBITAL_UPSTREAM_BASE_URL`, if the default upstream is not the one you want.
7. Nothing else on the client side: the app derives that URL itself for the `orbital` provider
   preset, from the project id in its Firebase config and from whether it is built against the
   emulator, and presents the signed-in account's ID token as the credential.

## Decisions worth knowing

Places where the contract left room, and what was chosen instead of guessing quietly:

- **`GET /v1/models` is authenticated but not entitlement-checked.** The catalogue is not an allowance,
  and this is the call the settings page uses to answer "is this endpoint reachable with this
  sign-in" — which has to keep answering for an account that is merely out of tokens or credits. It
  does read the plan, because the list depends on it, and reading the plan is also what applies the
  lazy refill.
- **A prompt costs a fixed number of credits, not a number derived from its tokens.** The catalogue's
  three tiers are the whole pricing model, so the figure the user is shown before asking is exactly
  what a successful prompt deducts — and the token counters are kept alongside as the auditable trail
  they always were. A per-token price would need a price table the upstream does not publish and a
  rounding decision this change was not asked to make.
- **The free plan's refill is lazy, on the first authenticated request past the instant.** No
  scheduled function: a cron would need a second deployment, a service account and a story for the
  hours it missed, while a lazy reset is idempotent and correct whenever it runs. The cost is that a
  period whose end has passed is only noticed by the next request — which is the first moment the
  numbers matter.
- **Nothing rolls over.** The reset writes `creditsUsed = 0`; there is no carry, no accrual and no
  proration, because a `creditsUsed` that can go negative is a balance and a balance is a billing
  system, which this is not.
- **`creditsLimit` on the document is an override, not a copy of the plan's.** The gateway leaves it
  alone unless the document already has one, so changing the free plan's limit in `config.ts` moves
  every account whose document does not spell out its own — and a grant to one account still wins.
- **The request body is parsed and re-serialised** (`{ ...body, model }`). Validating the model against
  the catalogue requires parsing, and re-serialising preserves keys, order and types — but it is a
  re-encoding, not a byte-for-byte copy of the request.
- **An interrupted stream gets an OpenAI-shaped `data: {"error": …}` frame** and then ends. The status
  was sent long before the upstream failed, and a silent truncation is indistinguishable from a broken
  network at the client's end.
- **No CORS handling.** The caller is the local runtime and the desktop app, not a browser page.
- **The region is `us-central1`**, set explicitly in `src/index.ts`, because the client's base URL is
  derived from it.
