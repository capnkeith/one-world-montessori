'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkerHeartbeat } = require('../src/core/WorkerHeartbeat');

function tempFilePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'owm-heartbeat-test-')), 'worker-heartbeat.json');
}

test('isHealthy is false when no check-in has ever happened', () => {
  const heartbeat = new WorkerHeartbeat(tempFilePath());
  assert.strictEqual(heartbeat.isHealthy(), false);
  assert.strictEqual(heartbeat.lastCheckedAt(), null);
});

test('isHealthy is true right after a check-in, false once past staleAfterMs', () => {
  const heartbeat = new WorkerHeartbeat(tempFilePath());
  const checkInAt = new Date(2026, 7, 1, 12, 0, 0);
  heartbeat.recordCheckIn(checkInAt);

  assert.strictEqual(heartbeat.isHealthy({ staleAfterMs: 60_000, now: new Date(checkInAt.getTime() + 30_000) }), true);
  assert.strictEqual(heartbeat.isHealthy({ staleAfterMs: 60_000, now: new Date(checkInAt.getTime() + 90_000) }), false);
});

test('a later check-in overwrites the earlier one, not accumulates', () => {
  const heartbeat = new WorkerHeartbeat(tempFilePath());
  heartbeat.recordCheckIn(new Date(2026, 7, 1, 12, 0, 0));
  heartbeat.recordCheckIn(new Date(2026, 7, 1, 12, 5, 0));
  assert.strictEqual(heartbeat.lastCheckedAt(), new Date(2026, 7, 1, 12, 5, 0).toISOString());
});

test('persists across separate instances pointed at the same file', () => {
  const filePath = tempFilePath();
  const first = new WorkerHeartbeat(filePath);
  first.recordCheckIn(new Date(2026, 7, 1, 12, 0, 0));

  const second = new WorkerHeartbeat(filePath);
  assert.strictEqual(second.lastCheckedAt(), new Date(2026, 7, 1, 12, 0, 0).toISOString());
});
