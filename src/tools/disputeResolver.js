'use strict';

const assert = require('node:assert');
const { z } = require('zod');
const { Tool } = require('../core/Tool');

/**
 * Finds job history entries with an unresolved Gmail thread and surfaces
 * whatever came back as plain data — it deliberately does NOT call
 * `claude.interpretReply` (or any Anthropic API) itself. That action
 * still exists on the `claude` tool and still works, but billing per
 * token for an always-on background loop wasn't something Seth wanted
 * to pay for, separately from whatever Claude Code/claude.ai plan is
 * already covering a real session. Instead, a Claude Code session (see
 * WORKER.md, served by the `worker` tool's `register` action) calls
 * checkReplies, reads `result.pending`, and resolves each entry itself —
 * patching a job's params via `scheduler.updateJob`, escalating via
 * `mail.send`, or just recording `{outcome: 'approved'}` — then calls
 * `scheduler.recordFeedback` directly. Never does meaningful work (never
 * touches Gmail beyond a cheap thread fetch) when there's nothing new to
 * check — cheap to poll often even though nothing here spends a token.
 *
 * Multi-node safe: Seth now has more than one Claude compute node running
 * this same recipe (himself, Johanna, more to come), each potentially
 * calling checkReplies around the same time. Before surfacing an entry as
 * pending, this claims it via scheduler.claimReplyEntry, under whichever
 * nodeId the shared `scheduler` tool instance was itself constructed with
 * (the same instanceId already used for job claiming, see index.js) -
 * only the node that wins the claim sees it in its own `pending` list, so
 * two nodes never independently act on the same reply (e.g. two different
 * escalation emails for one reply). If a node claims something and then
 * dies before calling recordFeedback, the claim's lease expires and
 * another node's next checkReplies picks it up - that's the failover
 * path, no separate cleanup step needed.
 *
 * Deliberately its own tool rather than folded into scheduler.js or
 * mail.js: it depends on both of those, and neither should need to know
 * about this orchestration to work standalone.
 */
function createDisputeResolverTool({ getSchedulerTool, getMailTool }) {
  return new Tool({
    name: 'disputeResolver',
    version: '2.1.0',
    description:
      "Finds unresolved replies to a job's sent email and returns them as data for an agent to resolve (see WORKER.md) — never calls the Anthropic API itself. Claims each entry first so multiple Claude compute nodes never act on the same reply.",
    mcpInputSchema: {
      action: z.enum(['checkReplies']).optional(),
    },

    run: async () => {
      const schedulerTool = getSchedulerTool();
      const mailTool = getMailTool();

      const { result: who } = await mailTool.invoke({ action: 'whoami' });
      const ownEmail = who.emailAddress;

      const { result: listed } = await schedulerTool.invoke({ action: 'listJobs' });

      const pending = [];
      let checked = 0;

      for (const job of listed.jobs) {
        for (let runIndex = 0; runIndex < job.history.length; runIndex++) {
          const entry = job.history[runIndex];
          const threadId = entry.detail?.threadId;
          if (entry.status !== 'success' || !threadId || entry.feedback !== undefined) continue;

          checked += 1;
          const { result: thread } = await mailTool.invoke({ action: 'getThread', id: threadId });
          const replies = thread.messages.filter((m) => m.from && !m.from.includes(ownEmail));
          if (replies.length === 0) continue;

          try {
            await schedulerTool.invoke({ action: 'claimReplyEntry', id: job.id, runIndex });
          } catch {
            continue; // another compute node already holds a live claim on this one
          }

          const latestReply = replies[replies.length - 1];
          pending.push({
            jobId: job.id,
            runIndex,
            jobLabel: job.label,
            jobType: job.type,
            jobParams: job.params,
            replyText: latestReply.body,
            repliedMessageId: latestReply.id,
            repliedFrom: latestReply.from,
          });
        }
      }

      return { checked, pending };
    },

    // Fully fake scheduler/mail tool stand-ins - never touches a real
    // inbox or a real job store. No claude tool stand-in at all anymore —
    // this tool has no dependency on it.
    internalTest: async ({ call }) => {
      const jobs = [
        {
          id: 'job-1',
          label: 'Monthly invoice',
          type: 'send-monthly-invoice-email',
          params: { to: 'businessmanager@oneworldmontessori.org' },
          history: [
            { status: 'success', detail: { threadId: 'thread-with-reply' } },
            { status: 'success', detail: { threadId: 'thread-no-reply-yet' } },
            { status: 'success', detail: { threadId: 'thread-already-resolved' }, feedback: { outcome: 'approved' } },
            { status: 'failed', detail: null },
          ],
        },
        {
          id: 'job-2',
          label: 'Another job with a reply',
          type: 'send-monthly-invoice-email',
          params: { to: 'someone@oneworldmontessori.org' },
          history: [{ status: 'success', detail: { threadId: 'thread-claimed-elsewhere' } }],
        },
      ];

      const fakeMailTool = {
        invoke: async (params) => {
          if (params.action === 'whoami') return { result: { emailAddress: 'claude@oneworldmontessori.org' } };
          if (params.action === 'getThread') {
            if (params.id === 'thread-with-reply') {
              return {
                result: {
                  threadId: params.id,
                  messages: [
                    { id: 'sent-1', from: 'claude@oneworldmontessori.org', body: 'Please find attached...' },
                    { id: 'reply-1', from: 'businessmanager@oneworldmontessori.org', body: 'Looks correct, approved.' },
                  ],
                },
              };
            }
            if (params.id === 'thread-claimed-elsewhere') {
              return {
                result: {
                  threadId: params.id,
                  messages: [
                    { id: 'sent-2', from: 'claude@oneworldmontessori.org', body: 'Please find attached...' },
                    { id: 'reply-2', from: 'someone@oneworldmontessori.org', body: 'Looks good.' },
                  ],
                },
              };
            }
            return { result: { threadId: params.id, messages: [{ id: 'sent-x', from: 'claude@oneworldmontessori.org', body: '...' }] } };
          }
          throw new Error(`unexpected mail action ${params.action}`);
        },
      };
      const claimCalls = [];
      const fakeSchedulerTool = {
        invoke: async (params) => {
          if (params.action === 'listJobs') return { result: { jobs } };
          if (params.action === 'claimReplyEntry') {
            claimCalls.push(params);
            // Simulates another compute node having already won the claim
            // on job-2's entry a moment earlier - this node must skip it.
            if (params.id === 'job-2') throw new Error('Reply entry job-2#0 is already claimed by other-node');
            return { result: jobs.find((j) => j.id === params.id) };
          }
          throw new Error(`unexpected scheduler action ${params.action}`);
        },
      };

      const fakeTool = createDisputeResolverTool({
        getSchedulerTool: () => fakeSchedulerTool,
        getMailTool: () => fakeMailTool,
      });

      const { result } = await fakeTool.invoke({ action: 'checkReplies' });
      assert.strictEqual(result.checked, 3, 'must skip the already-resolved and the failed-send entries, but check both jobs\' real replies');
      assert.strictEqual(
        result.pending.length,
        1,
        'must only surface the entry it actually won the claim on, not the one another node already claimed'
      );
      const [entry] = result.pending;
      assert.strictEqual(entry.jobId, 'job-1');
      assert.strictEqual(entry.runIndex, 0);
      assert.strictEqual(entry.replyText, 'Looks correct, approved.');
      assert.strictEqual(entry.repliedMessageId, 'reply-1');
      assert.strictEqual(entry.repliedFrom, 'businessmanager@oneworldmontessori.org');
      assert.deepStrictEqual(entry.jobParams, { to: 'businessmanager@oneworldmontessori.org' });

      assert.deepStrictEqual(
        claimCalls.map((c) => ({ id: c.id, runIndex: c.runIndex })),
        [
          { id: 'job-1', runIndex: 0 },
          { id: 'job-2', runIndex: 0 },
        ],
        'must attempt to claim every real reply it finds, not just the ones that succeed'
      );

      return { passed: true };
    },

    realWorldTest: async (testConfig, { call }) => {
      if (!testConfig.runDisputeResolverCheck) {
        return {
          passed: true,
          skipped: true,
          reason: 'testConfig.runDisputeResolverCheck not set — skipping (this would call the real mail tool)',
        };
      }
      const { result } = await call({ action: 'checkReplies' });
      assert.ok(typeof result.checked === 'number');
      assert.ok(Array.isArray(result.pending));
      return { passed: true, checkedAgainst: testConfig.label ?? 'unnamed-fixture' };
    },
  });
}

module.exports = { createDisputeResolverTool };
