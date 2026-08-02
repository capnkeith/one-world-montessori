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
 * CLAUDE.md's startup instruction) calls checkReplies, reads
 * `result.pending`, and resolves each entry itself — patching a job's
 * params via `scheduler.updateJob`, escalating via `mail.send`, or just
 * recording `{outcome: 'approved'}` — then calls `scheduler.recordFeedback`
 * directly. Never does meaningful work (never touches Gmail beyond a
 * cheap thread fetch) when there's nothing new to check — cheap to poll
 * often even though nothing here spends a token.
 *
 * Deliberately its own tool rather than folded into scheduler.js or
 * mail.js: it depends on both of those, and neither should need to know
 * about this orchestration to work standalone.
 */
function createDisputeResolverTool({ getSchedulerTool, getMailTool }) {
  return new Tool({
    name: 'disputeResolver',
    version: '2.0.0',
    description:
      "Finds unresolved replies to a job's sent email and returns them as data for an agent to resolve (see CLAUDE.md) — never calls the Anthropic API itself.",
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
            return { result: { threadId: params.id, messages: [{ id: 'sent-x', from: 'claude@oneworldmontessori.org', body: '...' }] } };
          }
          throw new Error(`unexpected mail action ${params.action}`);
        },
      };
      const fakeSchedulerTool = {
        invoke: async (params) => {
          if (params.action === 'listJobs') return { result: { jobs } };
          throw new Error(`unexpected scheduler action ${params.action}`);
        },
      };

      const fakeTool = createDisputeResolverTool({
        getSchedulerTool: () => fakeSchedulerTool,
        getMailTool: () => fakeMailTool,
      });

      const { result } = await fakeTool.invoke({ action: 'checkReplies' });
      assert.strictEqual(result.checked, 2, 'must skip the already-resolved and the failed-send entries');
      assert.strictEqual(result.pending.length, 1, 'must only surface the entry that actually has a reply');
      const [entry] = result.pending;
      assert.strictEqual(entry.jobId, 'job-1');
      assert.strictEqual(entry.runIndex, 0);
      assert.strictEqual(entry.replyText, 'Looks correct, approved.');
      assert.strictEqual(entry.repliedMessageId, 'reply-1');
      assert.strictEqual(entry.repliedFrom, 'businessmanager@oneworldmontessori.org');
      assert.deepStrictEqual(entry.jobParams, { to: 'businessmanager@oneworldmontessori.org' });

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
