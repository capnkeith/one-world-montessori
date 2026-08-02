'use strict';

const assert = require('node:assert');
const { z } = require('zod');
const { Tool } = require('../core/Tool');

/**
 * Closes the loop Seth designed for send-monthly-invoice-email (and any
 * future job type that emails someone and expects a reply): finds job
 * history entries with an unresolved Gmail thread, reads whatever came
 * back, has `claude`'s interpretReply turn free text into a structured
 * decision, and records it via `scheduler`'s recordFeedback. Nobody has
 * to click a fixed "approve" button - they can type whatever they want.
 *
 * Deliberately its own tool rather than folded into scheduler.js or
 * mail.js: it depends on both of those plus claude, and none of the
 * three should need to know about this orchestration to work standalone.
 */
function createDisputeResolverTool({ getSchedulerTool, getMailTool, getClaudeTool }) {
  return new Tool({
    name: 'disputeResolver',
    version: '1.0.0',
    description: "Reads replies to a job's sent email, has Claude interpret them, and records the resolution as feedback on that run.",
    mcpInputSchema: {
      action: z.enum(['checkReplies']).optional(),
    },

    run: async () => {
      const schedulerTool = getSchedulerTool();
      const mailTool = getMailTool();
      const claudeTool = getClaudeTool();

      const { result: who } = await mailTool.invoke({ action: 'whoami' });
      const ownEmail = who.emailAddress;

      const { result: listed } = await schedulerTool.invoke({ action: 'listJobs' });

      let checked = 0;
      let resolved = 0;

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
          const { result: resolution } = await claudeTool.invoke({
            action: 'interpretReply',
            replyText: latestReply.body,
            context: { jobLabel: job.label, jobType: job.type, jobParams: job.params },
          });

          await schedulerTool.invoke({
            action: 'recordFeedback',
            id: job.id,
            runIndex,
            feedback: { ...resolution, repliedMessageId: latestReply.id, repliedFrom: latestReply.from },
          });
          resolved += 1;
        }
      }

      return { checked, resolved };
    },

    // Fully fake scheduler/mail/claude tool stand-ins - never touches a
    // real inbox, a real job store, or a real Anthropic client.
    internalTest: async ({ call }) => {
      const jobs = [
        {
          id: 'job-1',
          label: 'Monthly invoice',
          type: 'send-monthly-invoice-email',
          params: {},
          history: [
            { status: 'success', detail: { threadId: 'thread-with-reply' } },
            { status: 'success', detail: { threadId: 'thread-no-reply-yet' } },
            { status: 'success', detail: { threadId: 'thread-already-resolved' }, feedback: { outcome: 'approved' } },
            { status: 'failed', detail: null },
          ],
        },
      ];
      let recordedFeedback = null;

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
      const fakeClaudeTool = {
        invoke: async (params) => {
          assert.strictEqual(params.action, 'interpretReply');
          assert.strictEqual(params.replyText, 'Looks correct, approved.');
          return { result: { outcome: 'approved', note: 'Fake interpretation' } };
        },
      };
      const fakeSchedulerTool = {
        invoke: async (params) => {
          if (params.action === 'listJobs') return { result: { jobs } };
          if (params.action === 'recordFeedback') {
            recordedFeedback = params;
            return { result: { ...jobs[0] } };
          }
          throw new Error(`unexpected scheduler action ${params.action}`);
        },
      };

      const fakeTool = createDisputeResolverTool({
        getSchedulerTool: () => fakeSchedulerTool,
        getMailTool: () => fakeMailTool,
        getClaudeTool: () => fakeClaudeTool,
      });

      const { result } = await fakeTool.invoke({ action: 'checkReplies' });
      assert.strictEqual(result.checked, 2, 'must skip the already-resolved and the failed-send entries');
      assert.strictEqual(result.resolved, 1, 'must only resolve the entry that actually has a reply');
      assert.ok(recordedFeedback);
      assert.strictEqual(recordedFeedback.id, 'job-1');
      assert.strictEqual(recordedFeedback.runIndex, 0);
      assert.strictEqual(recordedFeedback.feedback.outcome, 'approved');
      assert.strictEqual(recordedFeedback.feedback.repliedMessageId, 'reply-1');

      return { passed: true };
    },

    realWorldTest: async (testConfig, { call }) => {
      if (!testConfig.runDisputeResolverCheck) {
        return {
          passed: true,
          skipped: true,
          reason: 'testConfig.runDisputeResolverCheck not set — skipping (this would call the real mail/claude tools)',
        };
      }
      const { result } = await call({ action: 'checkReplies' });
      assert.ok(typeof result.checked === 'number');
      return { passed: true, checkedAgainst: testConfig.label ?? 'unnamed-fixture' };
    },
  });
}

module.exports = { createDisputeResolverTool };
