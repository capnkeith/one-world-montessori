# WORKER.md

Served by the `worker` tool's `register` action — fetch this over MCP at
the start of a session, rather than relying on this file being present
in a checked-out copy of the repo. This is what lets a Claude compute
node join the job-processing pool without ever needing this git repo
cloned locally: it just needs an MCP connection to a running OWM Drive
install (`claude mcp add owm-drive -- node
"<path-to-install>\src\server\mcp-server.js"`).

## Why this exists

OWM runs some number of Claude compute nodes at once (today: Seth and
Johanna, two licenses — expected to grow). Between them there are job
queues that need continual servicing. If a node disappears mid-task
(closes its session, crashes, loses network), another node needs to be
able to pick up the work rather than have it silently stall. This file
is the versioned, stable source of truth for how that actually works —
kept in the MCP server itself (not scattered across chat instructions)
so it evolves in lockstep with the code, and any compute node — present
or future — gets the same, current recipe.

## The email-reply-resolution queue

Some scheduled jobs email someone and later need a human/agent to read
whatever they wrote back and decide what to do about it (see
`src/tools/scheduler.js`, `src/tools/mail.js`,
`src/tools/disputeResolver.js`). This is deliberately **not** handled by
an always-on API call: `src/tools/claude.js`'s `interpretReply` action
can do this same job, but it bills the Anthropic API per token, and
that's not something Seth wants running continuously in the background,
separately from whatever Claude Code/claude.ai plan already covers a
real session. Instead, at the start of a session, do this yourself:

1. Check for pending replies against the local HTTP server (default
   port 39390):

   ```
   curl -s -X POST http://127.0.0.1:39390/tools/disputeResolver/invoke \
     -H "Content-Type: application/json" -d '{"action":"checkReplies"}'
   ```

   (No local HTTP server running? Use the CLI instead:
   `node src/cli.js call disputeResolver '{"action":"checkReplies"}'`, or
   just call the `disputeResolver` tool directly if you're connected over
   MCP.)

2. If `result.pending` is empty, there's nothing to do — don't mention
   it unless asked. This is normal and expected most of the time; poll
   again next session (or periodically, if this is a long-running one).

3. If it's non-empty, launch an Agent to work through the list. Each
   entry is `{jobId, runIndex, jobLabel, jobType, jobParams, replyText,
   repliedMessageId, repliedFrom}`. For each one, read `replyText` and
   decide:

   - Confirms everything is fine → resolve as `{outcome: 'approved'}`.
   - Clearly asks to stop/cancel (e.g. "stop", "reply stop to stop
     this" jobs) → cancel it via the `scheduler` tool's `cancelJob`
     action (`{action: 'cancelJob', id: jobId}`), then resolve as
     `{outcome: 'stopped', note: '...'}`.
   - Points out a specific, unambiguous fix (wrong recipient, wrong
     amount, wrong subject/body wording) → patch it via the `scheduler`
     tool's `updateJob` action: `{action: 'updateJob', id: jobId,
     params: {...jobParams, ...whateverChanged}}` — merge into the
     existing params, don't replace them outright — then resolve as
     `{outcome: 'updated', note: '...'}`.
   - Anything ambiguous, a real dispute, or needing human judgment →
     email Seth directly via the `mail` tool's `send` action (`to:
     seth@oneworldmontessori.org`, `subject` + `text` only), then
     resolve as `{outcome: 'escalated', note: '...'}`.

   Record whichever outcome via the `scheduler` tool's `recordFeedback`
   action: `{action: 'recordFeedback', id: jobId, runIndex, feedback:
   {outcome, note, repliedMessageId, repliedFrom}}`.

### Multiple compute nodes, no double-processing

You don't need to do anything differently because other nodes might be
running this same recipe concurrently — `checkReplies` already handles
it: internally, it claims each reply-bearing entry (`scheduler`'s
`claimReplyEntry` action) before including it in `result.pending`. If
another node already holds a live claim on an entry, it simply won't
appear in your `pending` list — you'll never see (and can't
accidentally act on) something someone else is already handling. If a
node claims something and then disappears before calling
`recordFeedback`, that claim's lease expires (10 minutes) and the next
node to call `checkReplies` — including a restarted version of the
same node — will see it again. That's the failover path Seth wants:
no manual intervention, no separate cleanup step, just call
`checkReplies` again.

### Hard guardrails — do not violate these

These mirror the DLP guardrail already enforced in code (see
`src/tools/mail.js`'s `assertAttachmentsAllowed` and
`src/core/Scheduler.js`'s `updateJob`), not just a preference:

- Never call `drive` or `catalog` as part of this flow. Nothing
  fetched from Drive may ever be attached to, or quoted verbatim into,
  an outbound email.
- Never pass `attachments` to `mail.send` in this flow at all — this
  flow only ever adjusts a job's own params or sends plain escalation
  text, never a document. (A job's real attachments, if any, are fixed
  at creation and can't be changed via `updateJob` anyway — enforced
  server-side, not just by convention.)
- Never try to change a job's `type` — `updateJob` only ever accepts
  `params`/`label`/`schedule`, regardless of what's sent.
- If in doubt, escalate to Seth rather than guess.

`claude.interpretReply` still exists and still works if Seth ever
explicitly wants to spend real API budget on this instead — it's just
not what drives the automatic flow.

## The prompt-answering queue (`promptQueue`)

The sample app's "Ask Claude" input bar used to call `claude.query`
directly — a real Anthropic API call, billed per token. It now submits
into this queue instead, answered by a Claude compute node the same way
email replies are — no API key, no per-token cost, just whichever
compute node happens to be checking.

1. Check for unanswered prompts:

   ```
   curl -s -X POST http://127.0.0.1:39390/tools/promptQueue/invoke \
     -H "Content-Type: application/json" -d '{"action":"checkPending"}'
   ```

   This also records a heartbeat check-in (see below) — calling it is
   itself the signal to the app that a compute node is around, even if
   `result.pending` comes back empty.

2. If `result.pending` is empty, there's nothing to do right now.

3. If it's non-empty, each entry is `{id, query, submittedAt}`. For each
   one: read `query`, figure out the actual answer yourself (you likely
   already have `drive`/`channel`/etc. tools available — use them
   normally, this queue has no special restriction on which tools you
   use to research the answer, unlike the reply-resolution queue's DLP
   guardrails), then call the `promptQueue` tool's `recordAnswer` action
   with `{id, answer}` — plain text, no forced files-vs-text structure
   the way the old API-driven `claude.query` had. Keep answers
   reasonably concise; this shows up directly in the sample app's
   preview pane.

4. Same multi-node safety as the reply queue: `checkPending` claims each
   prompt (`scheduler`-style claim/lease, 10-minute lease) before
   including it in `result.pending`, so two nodes checking at once never
   both answer the same prompt. A node that claims one and disappears
   before calling `recordAnswer` releases it automatically once the
   lease expires — the next `checkPending` (from any node) picks it up.

### Keep this queue actually alive

Unlike the reply queue (fine to check once at the start of a session),
this one directly gates whether the sample app's Ask Claude bar is even
enabled — the app polls `promptQueue`'s `health` action, which reports
whether *any* compute node has called `checkPending` within the last 5
minutes. If you're the one keeping this queue serviced during a work
session, check it periodically (every few minutes), not just once at
the start — otherwise the bar greys itself out for anyone using the
app, even though nothing is actually broken.

## Future queues

More job queues may get added here over time as OWM grows — this file
is the place that documents each one's recipe, so register once and
you have the current picture, no matter how many compute nodes are
running or which one happens to pick up a given piece of work.
