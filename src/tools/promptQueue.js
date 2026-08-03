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
    version: '1.0.0',
    description:
      'Queue for "Ask Claude" prompts, answered by a Claude compute node instead of the paid API: submit a prompt, checkPending to claim and answer, recordAnswer, getPrompt to poll, health to check if a provider is available.',
    mcpInputSchema: {
      action: z.enum(['submit', 'checkPending', 'recordAnswer', 'getPrompt', 'health']).optional(),
      query: z.string().optional(),
      id: z.string().optional(),
      answer: z.string().optional(),
    },

    run: async (params) => {
      const action = params?.action ?? 'checkPending';

      switch (action) {
        case 'submit':
          return promptQueue.submit({ query: params.query });

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
            pending.push({ id: prompt.id, query: prompt.query, submittedAt: prompt.submittedAt });
          }
          return { pending };
        }

        case 'recordAnswer':
          if (!params.id) throw new Error('recordAnswer requires id');
          if (!params.answer) throw new Error('recordAnswer requires answer');
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

      const submitted = await fakeTool.invoke({ action: 'submit', query: 'what is in my root folder?' });
      assert.ok(submitted.result.id);
      assert.strictEqual(submitted.result.answeredAt, null);

      const checked = await fakeTool.invoke({ action: 'checkPending' });
      assert.strictEqual(checked.result.pending.length, 1);
      assert.strictEqual(checked.result.pending[0].id, submitted.result.id);
      assert.strictEqual(checked.result.pending[0].query, 'what is in my root folder?');

      const after = await fakeTool.invoke({ action: 'health' });
      assert.strictEqual(after.result.available, true, 'checkPending must record a heartbeat check-in');

      // A second node checking concurrently must not also see it pending.
      const otherNodeTool = createPromptQueueTool({ promptStore: fakeStore, heartbeat: fakeHeartbeat, nodeId: 'other-node' });
      const checkedByOther = await otherNodeTool.invoke({ action: 'checkPending' });
      assert.strictEqual(checkedByOther.result.pending.length, 0, 'already claimed by test-node, must not double-surface');

      const midway = await fakeTool.invoke({ action: 'getPrompt', id: submitted.result.id });
      assert.strictEqual(midway.result.answered, false);

      const recorded = await fakeTool.invoke({ action: 'recordAnswer', id: submitted.result.id, answer: 'Just a README.md.' });
      assert.strictEqual(recorded.result.answer, 'Just a README.md.');

      const polled = await fakeTool.invoke({ action: 'getPrompt', id: submitted.result.id });
      assert.strictEqual(polled.result.answered, true);
      assert.strictEqual(polled.result.answer, 'Just a README.md.');

      // Once answered, it must never surface as pending again.
      const checkedAfterAnswer = await fakeTool.invoke({ action: 'checkPending' });
      assert.strictEqual(checkedAfterAnswer.result.pending.length, 0);

      await assert.rejects(() => fakeTool.invoke({ action: 'getPrompt', id: 'not-a-real-id' }), /No prompt with id/);

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
