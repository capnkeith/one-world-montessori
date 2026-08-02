# OWM — One World Montessori tools framework

Working notes for the MCP/CLI tools framework backing OWM's Google
Workspace automation. This document is the running spec — update it as
decisions change rather than letting Slack/chat be the only record.

## Context and constraints

- OWM runs entirely on Google Workspace; the operator has admin
  privileges (Admin SDK, Drive, Sheets, Classroom, Calendar, Gmail all
  in scope eventually).
- There is no central server to host anything on. Every install runs
  **locally**, one instance per user's machine (Windows primarily,
  some Mac).
- Most end users do not have Claude/MCP-host access. Two distinct
  consumer classes exist:
  1. **Technical staff** (the operator and others) — use the tools
     directly through a real MCP host (Claude Desktop/Code).
  2. **Everyone else** — reached through separately-built apps that
     are *not yet scoped*. This repo deliberately does not guess what
     those apps do; it only guarantees a stable tool interface for
     whatever they turn out to be, plus one minimal sample app proving
     the connection works.
- Distribution is self-install/self-update from source (originally a
  git-branch pattern from a prior project), not a package registry or
  central push.

## Architecture

```
                 ┌────────────────────────────────────────┐
                 │             ToolSet (versioned)          │
                 │   doctor@1.0.0   echo@1.0.0   (more...)  │
                 └───────────────┬──────────────────────────┘
                                 │  shared by all three front ends
        ┌────────────────────────┼────────────────────────┐
        │                        │                         │
   ┌─────────┐           ┌───────────────┐         ┌───────────────┐
   │   CLI   │           │ MCP stdio srv │         │ Local HTTP srv │
   │ src/cli │           │ (real MCP     │         │ (non-MCP-host  │
   │  .js    │           │  host, e.g.   │         │  consumers,    │
   │         │           │  Claude)      │         │  e.g. the      │
   │         │           │               │         │  sample app)   │
   └─────────┘           └───────────────┘         └───────────────┘
```

One shared `ToolSet` instance, three thin transports. Adding a real
Google Workspace tool means writing it once in `src/tools/` — it shows
up in the CLI, in Claude via MCP, and over local HTTP automatically.

## Versioning model

Everything is versioned independently, on purpose — so a bug report or
audit log can say exactly what ran, and individual tools can evolve
without forcing a server-wide bump:

- **Server version** — `package.json` version (`src/version.js` ->
  `SERVER_VERSION`).
- **ToolSet version** — bump when the *registry* changes shape (tools
  added/removed), independent of any single tool's internals
  (`TOOLSET_VERSION` in `src/version.js`).
- **Per-tool version** — each `Tool` carries its own semver
  (`src/core/Tool.js`).
- **Nested call version lineage** — when a tool calls another tool via
  `ctx.call(...)`, the callee's result carries the *full* ordered
  chain of `{tool, version}` pairs that led to it, not just its own.
  See `src/tools/echo.js` calling `doctor` internally, and
  `test/core.test.js` / `test/tools.test.js` for the exact shape.

This is deliberately about **traceability** (know exactly what
executed, all the way down) rather than **coexistence** (running
multiple versions of the same tool side by side) — the latter isn't
built and should be treated as a later decision if it's ever needed.

## Testing model

Every tool defines up to two tests (`src/core/Tool.js`):

- **Internal test** — canned parameters, no external side effects.
  Runs by default (`npm test`, or `owm-cli test`).
- **Real-world test** — performs an actual action against fixtures
  named in a `testConfig` (test server, test user, etc.). Never runs
  by accident: `ToolSet.runAllTests()` defaults to skipping real-world
  tests unless both `realWorld: true` and a `testConfig` are passed
  explicitly (`owm-cli test --real-world '{"label":"...","message":"..."}'`).

Today's `doctor`/`echo` real-world tests are stand-ins (they don't
touch Google yet). When real Google Workspace tools land, their
real-world tests should hit an actual designated test Workspace
user/domain — never production data.

## Secrets and profile

Two separate, deliberately different-shaped stores
(`src/core/SecretStore.js`, `src/core/Profile.js`):

- **SecretStore** — encrypted at rest, values are never exposed by any
  API (`has()`/`list()` only return booleans/key names, never values),
  never logged, never surfaced by `doctor`. `createSecretStore()`
  (`src/core/SecretStore.js`) picks a real OS-backed implementation
  automatically: **Windows** uses DPAPI
  (`System.Security.Cryptography.ProtectedData`, `CurrentUser` scope,
  via a short-lived PowerShell child process — the same mechanism
  Windows Credential Manager itself relies on, no native Node module
  needed) and **macOS** uses the login Keychain via the `security` CLI.
  Verified end-to-end on Windows (`test/secret-store.test.js`): a value
  round-trips correctly and the on-disk file never contains the
  plaintext. Linux still falls back to a local AES-file stand-in
  (`FileSecretStore`) — swap that one for a libsecret-backed
  implementation before Linux carries real credentials. The rest of
  the system only depends on the `get/set/has/delete/list` interface,
  never the storage mechanism.
- **Profile** — plain JSON, safe to print/log/ship in a bug report.
  Per-user settings that aren't secret (display name, preferences,
  test-mode flag, etc.).

**Auth model (recommended, not yet wired to real Google APIs):**
per-user OAuth — each local install authenticates as whoever is
logged in, scoped to what they can already see. Admin-only tools
(e.g. provisioning accounts) should separately check the caller's
actual Workspace role at call time rather than relying on a shared
powerful credential sitting on every machine.

## Install / update model

`bootstrap/install.js` — a local blue-green deploy with a
pre-promotion test gate:

1. **Stage** — pull candidate code into a throwaway temp dir. Source
   can be a git URL (`git clone --branch <ref> --depth 1`) or a local
   path (recursive copy, skipping `node_modules`/`.git`).
2. **Validate** — `npm install` and the *entire* test suite run
   inside the staging copy, bound to an isolated port
   (`OWM_TEST_PORT`) so it can never collide with a live running
   instance.
3. **Promote** — only if every test passes: move staging into
   `~/.owm-mcp/versions/<version>-<timestamp>/`, then atomically
   repoint the `~/.owm-mcp/current` junction at it.
4. **On failure** — the live `current` install is left completely
   untouched; nothing partial is ever promoted.

This was verified end-to-end during development: a real bug
(duplicate `const` declaration) introduced into a test file caused
the installer to correctly refuse to promote and leave the prior
install in place, then successfully promoted once fixed.

Usage:

```
node bootstrap/install.js <git-url-or-local-path> [branch]
# e.g.
node bootstrap/install.js git@github.com:capnkeith/OWM.git main
```

Windows note: promotion uses a directory **junction**
(`fs.symlinkSync(..., 'junction')`), which — unlike a symlink —
doesn't require admin/elevated privileges.

## Interfaces

- **CLI** (`src/cli.js`, run via `node src/cli.js` or `npm run cli --`):
  `list`, `doctor`, `call <tool> <json-params>`, `test [--real-world] [json-testConfig]`.
- **MCP stdio server** (`src/server/mcp-server.js`, `npm run mcp`):
  registers every tool in the shared ToolSet with the real MCP SDK
  (`@modelcontextprotocol/sdk`) — this is what a technical user points
  Claude Desktop/Code at.
- **Local HTTP server** (`src/server/http-server.js`, `npm run http`,
  default port 39390): `GET /tools`, `POST /tools/:name/invoke`. CORS
  is wide open (`*`) for the sample — restrict
  `Access-Control-Allow-Origin` to the real consuming app's origin
  before this goes further than a demo.

## Sample app

`sample-app/` is the deliberate "null app": plain HTML/JS (framework
choice doesn't matter — swap for anything later) plus a
`launch.bat` that starts the local HTTP server in its own console
window and opens the page. It calls `doctor` and `echo` over
`http://127.0.0.1:39390` exactly as any future real app would. This
proves the local-HTTP bridge works for consumers with zero Claude/MCP
access; it is not meant to be the actual product.

## Peer rendezvous / messaging (`channel` tool)

Every instance needs to know who else is online, and eventually pass
arbitrary data peer-to-peer — the concrete near-term use case is the
sample app showing "who else is running a server right now." What
peer-to-peer communication is actually *for* beyond that is
deliberately unscoped, same as the apps themselves; the `channel` tool
and its backend interface are built generically so whatever that turns
out to be doesn't require re-architecting the transport.

- **Interface** (`src/core/Channel.js`): `announce({instanceId,
  displayName})`, `list()` (peers seen within `staleAfterMs`),
  `send({from, to, type, payload})` (`to` is a specific instanceId or
  `'broadcast'`; `payload` is any JSON-serializable value), and
  `receive({instanceId, sinceSeq})` — at-least-once delivery via a
  monotonic `seq` cursor the receiver tracks, so nothing is missed or
  re-delivered across polls. Senders never receive their own messages back.
- **`InMemoryChannel`** — the default backend, correct within a single
  process. This is what tests use (`test/channel.test.js` proves two
  independent contexts — modeling two separate machines — discover
  each other and exchange arbitrary payloads over a shared channel
  instance) so `npm test` needs no real Google credentials. **It is not
  a real cross-machine rendezvous** — every locally-running instance
  currently only sees itself until a shared backend is wired in.
- **`GoogleSheetsChannel`** (`src/core/GoogleSheetsChannel.js`) — the
  designed-but-not-yet-live real backend: a shared Google Sheet with a
  `presence` tab and a `messages` tab, polling-based, at-least-once via
  atomic per-row appends + a seq backfill (avoids collisions if two
  peers send at once). This is genuinely the first thing that needs
  real Google API access — **provisioning it (a Google Cloud project,
  a service account scoped to only this one spreadsheet, the
  spreadsheet itself) is intentionally not automated**, since it means
  creating real, persistent infrastructure under the school's Google
  org rather than just writing code — that step needs your explicit
  go-ahead. Once a `spreadsheetId` and authenticated `sheetsClient`
  exist, wiring it in is a one-line change in `src/context.js`
  (swap `new InMemoryChannel()` for `new GoogleSheetsChannel({...})`).
  If push-based delivery or higher message volume is ever needed,
  swap in Firestore/Pub-Sub behind this same four-method interface
  instead — nothing above it would need to change.
- The local HTTP server announces this instance on startup and
  re-announces every 30s (server-process liveness, not browser-tab
  liveness) so it doesn't go stale in peers' `channel list` results.
- The sample app polls `channel.list()` every 5s to show who's online,
  and has send/receive buttons demonstrating arbitrary-payload transmission.

## Real Google Drive access (`drive` tool)

The first tool that talks to a real Google Workspace resource — deliberately just browsing, no metadata layer yet ("browse the real files first, metadata later"; the metadata/event-sourcing groundwork from an earlier design pass exists but is parked — see `src/core/FileCatalog.js`, `CatalogEventLog.js`, `src/tools/catalog.js` — not wired into the ToolSet).

**Auth path, and why it's not the obvious one:** the first attempt used `gcloud auth application-default login` with Drive scopes against gcloud's own shared/default OAuth client — this is now actively blocked by Google ("This app tried to access sensitive info... Google blocked this access") because Google is restricting sensitive scopes on that shared client. The real fix, per Google's own error message, is a dedicated OAuth client:

1. A dedicated GCP project (`owm-drive-browser`) — required accepting Google Cloud's Terms of Service once via the Console (a real account/legal action, not something automated on your behalf).
2. An OAuth consent screen configured Internal (org-restricted, so it never needs Google's app-verification review) via Google's newer "Google Auth Platform" Console UI (Branding/Audience/Clients tabs — the old "OAuth consent screen" single-page flow has been replaced).
3. An OAuth 2.0 Client ID of type **Desktop app**, downloaded as a `client_secret_*.json` file.
4. That file is loaded once via `drive`'s `setup` action, which stores its contents in `SecretStore` under `google_oauth_client` — the plaintext download can then be deleted; it lives encrypted (DPAPI on Windows) from then on.
5. First `browse`/`search` call with no cached token triggers a one-time interactive consent: a local loopback HTTP server (`src/core/googleAuth.js`) on an OS-assigned port, browser opened automatically, user signs in and approves `drive.readonly`, and the resulting **refresh token** is stored under `google_oauth_refresh_token` in `SecretStore`. Every subsequent call reuses it silently, no browser involved.

**Why this already fits the "same Google access privileges per user" goal:** the Desktop app's `client_id`/`client_secret` identify the *application*, not a person — Google's own guidance treats these as safe to embed/distribute to every install (that's what "Desktop app" client type means). What's actually sensitive and personal is the **refresh token** each individual user gets after their own consent step — so every user runs their own one-time `drive setup` + consent using the *same* distributed client JSON, and each ends up with their own refresh token reflecting their own real Drive permissions. Nothing here uses a domain-wide-delegation admin credential.

**Actions:** `setup` (one-time, stores the client JSON), `browse` (`folderId`, defaults to `root`), `search` (`query`, matches by name). Internal tests use a fully fake Drive client (`test/drive.test.js`) — `npm test` never touches real Google. The real-world test only actually calls real Drive when a `testConfig.folderId` is explicitly supplied (e.g. `node src/cli.js test --real-world '{"folderId":"root"}'`), so the generic cross-tool test sweep skips it gracefully rather than making a surprise live API call.

**Verified against the real account (2026-07):** `browse` on `root` returned Seth's actual Drive folder/file listing; the sample app now has a Drive panel (breadcrumb navigation + search) that browses it live over the local HTTP server.

**Still open:** this only reads (no open/download of actual file *content* yet — Drive API's `files.get` with `alt=media` is the next piece if that's wanted), and it authenticates one account at a time per machine, not yet distributed as an easy setup flow for other users.

## Automated email reply handling (`disputeResolver`, `scheduler`, `mail`)

A job that emails someone (e.g. `send-monthly-invoice-email`) often
gets a reply that needs a decision: approve, fix a param, or escalate
to a human. `disputeResolver.checkReplies` finds unresolved reply
threads and returns them as plain data — **it deliberately never calls
the Anthropic API itself**. `claude.js`'s `interpretReply` action can
do that same reasoning agentically, but it bills per token, and an
always-on background loop calling it wasn't something Seth wanted to
pay for on top of whatever Claude Code/claude.ai plan already covers a
real session. So the resolving step is done by a Claude Code session
instead — see `CLAUDE.md` at the repo root, which any session opened
here picks up automatically, telling it to check for pending replies
at startup and resolve them directly via `scheduler`/`mail`, under the
same guardrails.

**DLP guardrail (hard, not just prompted):** no OWM Drive content may
ever leave via email. `mail.send` rejects any attachment not tagged
`source: 'rendered'` (built fresh by a rendering tool, e.g.
`invoice`/`pdf`) or `'job-defined'` (fixed on the job at `addJob` time)
— see `src/tools/mail.js`'s `assertAttachmentsAllowed`.
`Scheduler.updateJob` deliberately never touches a job's `attachments`
or `type`, even if asked to, so nothing (a careless job handler, a
future Claude tool, an agent following CLAUDE.md) can redirect a job
into attaching something it wasn't created with, or turn it into a
different kind of job. `escalate_to_seth` (the `claude` tool's
escape-hatch action) has no attachment parameter at all.

## Running everything

```
npm install
npm test                       # internal tests, all tools, ephemeral ports
npm run doctor                 # CLI shortcut for `call doctor {}`
npm run mcp                    # MCP stdio server (point Claude Desktop at this)
npm run http                   # local HTTP server for the sample app
sample-app\launch.bat          # starts the HTTP server + opens the sample page
node bootstrap/install.js <source> [branch]   # staged blue-green install/update
```

## Open items / next steps

- **Provisioning the real `channel` backend** — a Google Cloud
  project, a service account scoped to one spreadsheet, and the
  spreadsheet itself. Needs your explicit go-ahead since it creates
  real infrastructure under the school's org (see "Peer rendezvous /
  messaging" above). This is the most concrete, well-scoped next step.
  Runbook, ready to execute the moment you say go (needs `gcloud` —
  not yet installed on this machine — authenticated as an account with
  rights to create projects under the org, likely you):

  ```
  # 1. Auth (browser device-flow, same pattern as the GitHub CLI setup)
  gcloud auth login

  # 2. A dedicated project (keeps this fully isolated/revocable)
  gcloud projects create owm-mcp-channel --name "OWM MCP Channel"
  gcloud config set project owm-mcp-channel

  # 3. Enable only what's needed
  gcloud services enable sheets.googleapis.com drive.googleapis.com

  # 4. A service account scoped to nothing but this one spreadsheet
  gcloud iam service-accounts create owm-channel \
    --display-name "OWM channel (presence + messages sheet only)"
  gcloud iam service-accounts keys create owm-channel-key.json \
    --iam-account owm-channel@owm-mcp-channel.iam.gserviceaccount.com

  # 5. The spreadsheet: create it with the service account's own credentials
  #    (owned by the service account, so no separate sharing step needed),
  #    or create it as yourself and share Editor with the service
  #    account's email — either way, add a `presence` tab and a
  #    `messages` tab (see src/core/GoogleSheetsChannel.js for the exact
  #    column layout it expects).

  # 6. Store the key via SecretStore (never as a plaintext file in the repo),
  #    point src/context.js at `new GoogleSheetsChannel({ spreadsheetId, sheetsClient })`
  #    instead of `new InMemoryChannel()`, and add the `googleapis` package.
  ```
- **Real Google Workspace tools** — nothing here talks to Google yet
  otherwise. Apps are intentionally unscoped ("null app"); the first
  real tools to add are whatever the first actual app needs.
- **Real OAuth flow** — per-user Google sign-in, token storage via
  `SecretStore`, admin-role check for privileged tools.
- **Linux SecretStore backend** — still the AES-file stand-in; wire up
  libsecret before Linux carries real credentials (low priority — no
  Linux users in scope today).
- **Mac support** — the Node core, CLI, HTTP server, `SecretStore`
  (Keychain-backed), and `bootstrap/install.js`'s promotion step
  (POSIX symlink instead of a Windows junction) are all now
  platform-aware. The Mac paths are implemented but not yet run on an
  actual Mac — only verified by inspection and Windows execution.
- **Distributing the installer itself** — how a non-technical teacher
  gets `bootstrap/install.js` onto their machine for the very first
  time (no git/Node preinstalled to assume) is still open.
- Repo: https://github.com/capnkeith/OWM
