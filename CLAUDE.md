# CLAUDE.md

Instructions for any Claude Code session opened in this repository.

## Email reply processing (disputeResolver)

Some scheduled jobs email someone and later need a human/agent to read
whatever they wrote back and decide what to do about it (see
`src/tools/scheduler.js`, `src/tools/mail.js`,
`src/tools/disputeResolver.js`). This is deliberately **not** handled by
an always-on API call: `src/tools/claude.js`'s `interpretReply` action
can do this same job, but it bills the Anthropic API per token, and
Seth doesn't want that running continuously in the background separate
from whatever Claude Code/claude.ai plan already covers a real session.
So instead, at the start of a session here, do this yourself:

1. Check for pending replies against the local HTTP server (default
   port 39390):

   ```
   curl -s -X POST http://127.0.0.1:39390/tools/disputeResolver/invoke \
     -H "Content-Type: application/json" -d '{"action":"checkReplies"}'
   ```

   (If the server isn't running locally, use the CLI instead:
   `node src/cli.js call disputeResolver '{"action":"checkReplies"}'`.)

2. If `result.pending` is empty, there's nothing to do — don't mention
   it unless asked.

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
