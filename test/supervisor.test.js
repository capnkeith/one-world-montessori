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

// onGiveUp/onHealthyRun are the actual "no user intervention" diagnostics
// hooks (see bootstrap/diagnostics.js) - both default to a no-op, so every
// test above is unaffected, but the loop's contract with them needs its
// own coverage: called at the right moment, with the right info, and
// never allowed to break the supervise/restart loop itself if either one
// throws (failing to *report* a failure must never become a second one).

test('runSupervisorLoop calls onGiveUp exactly once, with the final failCount, the moment it gives up', async () => {
  const giveUpCalls = [];
  const result = await runSupervisorLoop({
    spawnChild: async () => 1,
    sleep: async () => {},
    log: () => {},
    now: () => 0,
    onGiveUp: async (info) => giveUpCalls.push(info),
  });

  assert.strictEqual(result.gaveUp, true);
  assert.strictEqual(giveUpCalls.length, 1);
  assert.strictEqual(giveUpCalls[0].failCount, result.failCount);
});

test('a throwing onGiveUp is caught and logged, and never prevents the loop from returning gaveUp: true', async () => {
  const logs = [];
  const result = await runSupervisorLoop({
    spawnChild: async () => 1,
    sleep: async () => {},
    log: (msg) => logs.push(msg),
    now: () => 0,
    onGiveUp: async () => {
      throw new Error('diagnostics send exploded');
    },
  });

  assert.strictEqual(result.gaveUp, true);
  assert.ok(logs.some((l) => l.includes('onGiveUp itself failed') && l.includes('diagnostics send exploded')));
});

/** Builds a `now()` sequence (two calls per run: startedAt, then after) that yields exactly the given ranMs per run. */
function nowSequenceFor(ranMsPerRun) {
  const timestamps = [];
  let clock = 0;
  for (const ranMs of ranMsPerRun) {
    timestamps.push(clock);
    clock += ranMs;
    timestamps.push(clock);
  }
  let i = 0;
  return () => timestamps[i++];
}

test('runSupervisorLoop calls onHealthyRun after a healthy run, never after a fast-failure backoff', async () => {
  const healthyCalls = [];
  // One healthy run (resets failCount to 0), then six fast failures in a
  // row to actually reach giveUp and end the loop for this test.
  const now = nowSequenceFor([70_000, 0, 0, 0, 0, 0, 0]);

  const result = await runSupervisorLoop({
    spawnChild: async () => 1,
    sleep: async () => {},
    log: () => {},
    now,
    onHealthyRun: async (info) => healthyCalls.push(info),
  });

  assert.strictEqual(result.gaveUp, true);
  assert.strictEqual(healthyCalls.length, 1, 'must fire for the one healthy run, not for any of the six fast failures after it');
  assert.strictEqual(healthyCalls[0].ranMs, 70_000);
});

test('a throwing onHealthyRun is caught and logged, and never prevents the loop from continuing', async () => {
  const logs = [];
  const now = nowSequenceFor([70_000, 0, 0, 0, 0, 0, 0]);

  const result = await runSupervisorLoop({
    spawnChild: async () => 1,
    sleep: async () => {},
    log: (msg) => logs.push(msg),
    now,
    onHealthyRun: async () => {
      throw new Error('pending-report retry exploded');
    },
  });

  assert.strictEqual(result.gaveUp, true, 'the loop must keep going through the six fast failures after onHealthyRun throws, same as if it had succeeded');
  assert.ok(logs.some((l) => l.includes('onHealthyRun itself failed') && l.includes('pending-report retry exploded')));
});
