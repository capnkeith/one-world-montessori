'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createWorkerTool } = require('../src/tools/worker');

test('register reads the real WORKER.md file by default (not just a fake-injected string)', async () => {
  const tool = createWorkerTool();
  const { result } = await tool.invoke({ action: 'register' });
  assert.match(result.instructions, /disputeResolver/);
  assert.match(result.instructions, /claimReplyEntry/);
  assert.match(result.instructions, /promptQueue/);
});

test('an unknown action throws a clear error', async () => {
  const tool = createWorkerTool({ readInstructions: () => 'unused' });
  await assert.rejects(() => tool.invoke({ action: 'not-a-real-action' }), /Unknown worker action/);
});
