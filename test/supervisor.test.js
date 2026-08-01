'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { decideNextAction, runSupervisorLoop } = require('../bootstrap/supervisor');

test('a child that runs long enough counts as healthy and resets backoff', () => {
  const decision = decideNextAction({ ranMs: 61_000, failCount: 4 });
  assert.strictEqual(decision.action, 'restart');
  assert.strictEqual(decision.delayMs, 0);
  assert.strictEqual(decision.failCount, 0);
});

test('a fast-failing child backs off exponentially', () => {
  const first = decideNextAction({ ranMs: 100, failCount: 0 });
  assert.strictEqual(first.action, 'restart');
  assert.strictEqual(first.delayMs, 5_000);

  const second = decideNextAction({ ranMs: 100, failCount: 1 });
  assert.strictEqual(second.delayMs, 10_000);

  const third = decideNextAction({ ranMs: 100, failCount: 2 });
  assert.strictEqual(third.delayMs, 20_000);
});

test('backoff is capped rather than growing forever', () => {
  const decision = decideNextAction({ ranMs: 100, failCount: 3 });
  assert.ok(decision.delayMs <= 5 * 60_000);
});

test('gives up after too many consecutive fast failures instead of retrying forever', () => {
  const decision = decideNextAction({ ranMs: 100, failCount: 5 });
  assert.strictEqual(decision.action, 'giveUp');
});

test('runSupervisorLoop restarts a fast-failing child with backoff, then gives up — never retries unbounded', async () => {
  const logs = [];
  const sleeps = [];
  let spawnCount = 0;

  const result = await runSupervisorLoop({
    spawnChild: async () => {
      spawnCount += 1;
      return 1; // simulate a crash every time
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (msg) => logs.push(msg),
    now: () => 0, // ranMs is always 0 => every run is a "fast failure"
  });

  assert.strictEqual(result.gaveUp, true);
  assert.ok(spawnCount >= 5 && spawnCount < 20, `expected a bounded number of restarts, got ${spawnCount}`);
  assert.ok(sleeps.every((ms) => ms <= 5 * 60_000));
  assert.ok(logs.some((line) => line.includes('giving up')));
});
