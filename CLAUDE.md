# CLAUDE.md

Instructions for any Claude Code session opened in this repository
(i.e. you're developing *on* OWM Drive itself, not just connected to it
over MCP as a compute node — for that, see below).

## Email reply processing (disputeResolver) — see WORKER.md

The actual recipe for finding and resolving pending email replies now
lives in `WORKER.md`, not here — it's served live over MCP by the
`worker` tool's `register` action, so any Claude compute node can fetch
it without needing this repo checked out (Johanna's session, and any
future one, won't have it locally). If you're working in this repo and
want to do this yourself, either call `worker`'s `register` action or
just read `WORKER.md` directly — same content either way.

Do not duplicate that recipe here — it's meant to have exactly one
source of truth so it can't drift out of sync with what the code
actually does.
