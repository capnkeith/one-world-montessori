'use strict';

const assert = require('node:assert');
const { z } = require('zod');
const { Tool } = require('../core/Tool');
const { PromptQueue } = require('../core/PromptQueue');

/**
 * The second job queue (see WORKER.md): the sample app's "Ask Claude" bar
 * submits a prompt here instead of calling claude.query (which bills the
 * Anthropic API per token). A Claude compute node calls `checkPending`,
 * answers each one in plain text, and calls `recordAnswer` - the app
 * polls `getPrompt` for the answer. `health` reports whether any compute
 * node has checked recently, so the app can grey out the bar rather than
 * accept prompts that might sit unanswered.
 *
 * `nodeId` identifies this instance for the claim/lease model, same
 * convention as the `scheduler` tool.
 */
function createPromptQueueTool({ promptStore, heartbeat, nodeId = `node-${Math.random().toString(36).slice(2)}` }) {
  const promptQueue = new PromptQueue({ store: promptStore });

  return new Tool({
    name: 'promptQueue',
    version: '1.1.0',
    description:
      'Queue for "Ask Claude" prompts, answered by a Claude compute node instead of the paid API: submit a prompt, checkPending to claim and answer, recordAnswer (text plus optional Drive entries), getPrompt to poll, health to check if a provider is available.',
    mcpInputSchema: {
      action: z.enum(['submit', 'checkPending', 'recordAnswer', 'getPrompt', 'health']).optional(),
      query: z.string().optional(),
      id: z.string().optional(),
      answer: z
        .object({
          text: z.string(),
          entries: z
            .array(
              z.object({
                id: z.string(),
                name: z.string(),
                mimeType: z.string().optional(),
                isFolder: z.boolean().optional(),
                webViewLink: z.string().optional(),
              })
            )
            .optional(),
        })
        .optional(),
    },

    run: async (params, ctx) => {
      const action = params?.action ?? 'checkPending';

      switch (action) {
        case 'submit':
          // `ctx.user` is whichever real account this OWM install/process
          // resolved to (see ToolSet._resolveUser) - carried along so
          // whichever compute node answers can see whose query this is.
          return promptQueue.submit({ query: params.query, user: ctx?.user ?? null });

        case 'checkPending': {
          heartbeat.recordCheckIn();
          const pending = [];
          for (const prompt of promptQueue.listPrompts()) {
            if (prompt.answeredAt) continue;
            try {
              promptQueue.claimPrompt({ id: prompt.id, nodeId });
            } catch {
              continue; // another compute node already holds a live claim on this one
            }
            pending.push({ id: prompt.id, query: prompt.query, user: prompt.user ?? null, submittedAt: prompt.submittedAt });
          }
          return { pending };
        }

        case 'recordAnswer':
          if (!params.id) throw new Error('recordAnswer requires id');
          if (!params.answer?.text) throw new Error('recordAnswer requires answer.text');
          return promptQueue.recordAnswer({ id: params.id, answer: params.answer });

        case 'getPrompt': {
          if (!params.id) throw new Error('getPrompt requires id');
          const prompt = promptQueue.getPrompt(params.id);
          if (!prompt) throw new Error(`No prompt with id ${params.id}`);
          return { id: prompt.id, query: prompt.query, answered: Boolean(prompt.answeredAt), answer: prompt.answer };
        }

        case 'health':
          return { available: heartbeat.isHealthy() };

        default:
          throw new Error(`Unknown promptQueue action: ${action}`);
      }
    },

    // Fully self-contained: its own throwaway store/heartbeat, never
    // touches the real prompt file.
    internalTest: async ({ call }) => {
      let prompts = [];
      const fakeStore = {
        load: () => prompts,
        save: (next) => {
          prompts = next;
        },
        mutate: (id, updaterFn) => {
          const prompt = prompts.find((p) => p.id === id);
          if (!prompt) return null;
          return updaterFn(prompt) ? prompt : null;
        },
      };
      let checkIns = 0;
      const fakeHeartbeat = {
        recordCheckIn: () => {
          checkIns += 1;
        },
        isHealthy: () => checkIns > 0,
      };
      const fakeTool = createPromptQueueTool({ promptStore: fakeStore, heartbeat: fakeHeartbeat, nodeId: 'test-node' });

      const before = await fakeTool.invoke({ action: 'health' });
      assert.strictEqual(before.result.available, false, 'no provider has checked in yet');

      // Submitted through a ctx carrying a real user identity (as
      // ToolSet.invoke would provide) - must be carried onto the prompt
      // so whichever compute node answers can see whose query this is.
      const askingUser = { email: 'seth@oneworldmontessori.org', displayName: 'Seth' };
      const submitted = await fakeTool.invoke({ action: 'submit', query: 'what is in the OWM folder?' }, { user: askingUser });
      assert.ok(submitted.result.id);
      assert.strictEqual(submitted.result.answeredAt, null);
      assert.deepStrictEqual(submitted.result.user, askingUser);

      const checked = await fakeTool.invoke({ action: 'checkPending' });
      assert.strictEqual(checked.result.pending.length, 1);
      assert.strictEqual(checked.result.pending[0].id, submitted.result.id);
      assert.strictEqual(checked.result.pending[0].query, 'what is in the OWM folder?');
      assert.deepStrictEqual(checked.result.pending[0].user, askingUser, 'the answering compute node must see whose query this is');

      const after = await fakeTool.invoke({ action: 'health' });
      assert.strictEqual(after.result.available, true, 'checkPending must record a heartbeat check-in');

      // A second node checking concurrently must not also see it pending.
      const otherNodeTool = createPromptQueueTool({ promptStore: fakeStore, heartbeat: fakeHeartbeat, nodeId: 'other-node' });
      const checkedByOther = await otherNodeTool.invoke({ action: 'checkPending' });
      assert.strictEqual(checkedByOther.result.pending.length, 0, 'already claimed by test-node, must not double-surface');

      const midway = await fakeTool.invoke({ action: 'getPrompt', id: submitted.result.id });
      assert.strictEqual(midway.result.answered, false);

      await assert.rejects(
        () => fakeTool.invoke({ action: 'recordAnswer', id: submitted.result.id, answer: { text: '' } }),
        /requires answer\.text/,
        'an empty text answer must be rejected the same as a missing one'
      );

      // Structured answer: text plus real Drive entries (a folder listing
      // or a single file), so the app can render actual clickable Drive
      // results instead of just a text description.
      const entries = [
        { id: 'folder-1', name: 'OWM', mimeType: 'application/vnd.google-apps.folder', isFolder: true },
        { id: 'file-1', name: 'Handbook.pdf', mimeType: 'application/pdf', isFolder: false, webViewLink: 'https://drive.example/file-1' },
      ];
      const recorded = await fakeTool.invoke({
        action: 'recordAnswer',
        id: submitted.result.id,
        answer: { text: 'Found one folder and one file.', entries },
      });
      assert.strictEqual(recorded.result.answer.text, 'Found one folder and one file.');
      assert.deepStrictEqual(recorded.result.answer.entries, entries);

      const polled = await fakeTool.invoke({ action: 'getPrompt', id: submitted.result.id });
      assert.strictEqual(polled.result.answered, true);
      assert.strictEqual(polled.result.answer.text, 'Found one folder and one file.');
      assert.deepStrictEqual(polled.result.answer.entries, entries);

      // Once answered, it must never surface as pending again.
      const checkedAfterAnswer = await fakeTool.invoke({ action: 'checkPending' });
      assert.strictEqual(checkedAfterAnswer.result.pending.length, 0);

      await assert.rejects(() => fakeTool.invoke({ action: 'getPrompt', id: 'not-a-real-id' }), /No prompt with id/);

      // A plain (non-Drive) question just omits entries entirely.
      const plainSubmitted = await fakeTool.invoke({ action: 'submit', query: 'what time is it?' });
      assert.strictEqual(plainSubmitted.result.user, null, 'submitting with no ctx.user at all must not throw, just record null');
      await fakeTool.invoke({ action: 'recordAnswer', id: plainSubmitted.result.id, answer: { text: 'No idea, I don\'t track time.' } });
      const plainPolled = await fakeTool.invoke({ action: 'getPrompt', id: plainSubmitted.result.id });
      assert.strictEqual(plainPolled.result.answer.entries, undefined);

      return { passed: true };
    },

    realWorldTest: async (testConfig, { call }) => {
      const { result } = await call({ action: 'health' });
      assert.strictEqual(typeof result.available, 'boolean');
      return { passed: true, checkedAgainst: testConfig.label ?? 'unnamed-fixture' };
    },
  });
}

module.exports = { createPromptQueueTool };
