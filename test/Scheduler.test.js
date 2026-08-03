'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Scheduler, computeNextMonthlyRun } = require('../src/core/Scheduler');

function fakeStore(initial = []) {
  let jobs = initial;
  return {
    load: () => jobs,
    save: (next) => {
      jobs = next;
    },
    mutate: (id, updaterFn) => {
      const job = jobs.find((j) => j.id === id);
      if (!job) return null;
      const shouldSave = updaterFn(job);
      return shouldSave ? job : null;
    },
  };
}

test('computeNextMonthlyRun picks this month if the day hasn\'t passed yet, otherwise next month', () => {
  const beforeDay = new Date(2026, 7, 1, 8, 0); // Aug 1, 8am
  const next = computeNextMonthlyRun(beforeDay, 2, 9, 0);
  assert.strictEqual(next.getFullYear(), 2026);
  assert.strictEqual(next.getMonth(), 7); // August (0-indexed)
  assert.strictEqual(next.getDate(), 2);
  assert.strictEqual(next.getHours(), 9);

  const afterDay = new Date(2026, 7, 5, 8, 0); // Aug 5
  const rolledOver = computeNextMonthlyRun(afterDay, 2, 9, 0);
  assert.strictEqual(rolledOver.getMonth(), 8); // rolls to September
  assert.strictEqual(rolledOver.getDate(), 2);
});

test('addJob computes nextRunAt from the schedule, defaults to status scheduled and retryPolicy idempotent', () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const now = new Date(2026, 7, 1, 12, 0);
  const job = scheduler.addJob({
    type: 'send-invoice',
    label: 'Monthly invoice',
    schedule: { type: 'monthly', dayOfMonth: 2, hour: 9, minute: 0 },
    params: { to: 'businessmanager@oneworldmontessori.org' },
    now,
  });

  assert.strictEqual(job.status, 'scheduled');
  assert.strictEqual(job.retryPolicy, 'idempotent');
  assert.strictEqual(job.claimedBy, null);
  assert.strictEqual(new Date(job.nextRunAt).getDate(), 2);
  assert.strictEqual(job.history.length, 0);
});

test('addJob accepts an explicit retryPolicy (e.g. at-most-once for side-effecting jobs)', () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const job = scheduler.addJob({
    type: 'send-invoice',
    schedule: { type: 'monthly', dayOfMonth: 2 },
    retryPolicy: 'at-most-once',
    now: new Date(2026, 7, 1),
  });
  assert.strictEqual(job.retryPolicy, 'at-most-once');
});

test('runJob claims the job, executes the handler, records history, and reschedules a recurring job', async () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const now = new Date(2026, 7, 1, 12, 0);
  const job = scheduler.addJob({
    type: 'send-invoice',
    schedule: { type: 'monthly', dayOfMonth: 2 },
    params: { to: 'businessmanager@oneworldmontessori.org' },
    now,
  });

  const sentTo = [];
  const handlers = {
    'send-invoice': async (params) => {
      sentTo.push(params.to);
      return { sent: true };
    },
  };

  const ranAt = new Date(2026, 7, 2, 9, 0);
  const updated = await scheduler.runJob(job.id, { handlers, now: ranAt });

  assert.deepStrictEqual(sentTo, ['businessmanager@oneworldmontessori.org']);
  assert.strictEqual(updated.history.length, 1);
  assert.strictEqual(updated.history[0].status, 'success');
  assert.deepStrictEqual(updated.history[0].detail, { sent: true });
  assert.strictEqual(updated.lastRunAt, ranAt.toISOString());
  assert.strictEqual(updated.status, 'scheduled', 'a recurring job stays scheduled after running');
  assert.strictEqual(updated.claimedBy, null, 'the claim must be released after completion');
  assert.strictEqual(new Date(updated.nextRunAt).getMonth(), 8, 'monthly job reschedules into the following month');
});

test('runJob records a failed run instead of throwing when the handler itself throws', async () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const job = scheduler.addJob({
    type: 'flaky',
    schedule: { type: 'once', at: new Date(2026, 7, 2).toISOString() },
    now: new Date(2026, 7, 1),
  });

  const handlers = { flaky: async () => { throw new Error('smtp down'); } };
  const updated = await scheduler.runJob(job.id, { handlers, now: new Date(2026, 7, 2) });

  assert.strictEqual(updated.history[0].status, 'failed');
  assert.strictEqual(updated.history[0].error, 'smtp down');
  assert.strictEqual(updated.status, 'completed', 'a one-off job completes (stops being scheduled) even if its run failed');
});

test('runJob records a failed run (does not throw) when no handler is registered for the job type', async () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const job = scheduler.addJob({
    type: 'send-invoice',
    schedule: { type: 'monthly', dayOfMonth: 2 },
    now: new Date(2026, 7, 1),
  });

  const updated = await scheduler.runJob(job.id, { handlers: {} });
  assert.strictEqual(updated.history[0].status, 'failed');
  assert.match(updated.history[0].error, /No handler registered/);
  assert.strictEqual(updated.claimedBy, null, 'the claim must still be released even on this failure path');
});

test('runJob throws when the job is already claimed by someone else', async () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const job = scheduler.addJob({
    type: 'a',
    schedule: { type: 'monthly', dayOfMonth: 2 },
    now: new Date(2026, 7, 1),
  });
  scheduler.claimJob(job.id, { nodeId: 'node-a', now: new Date(2026, 7, 2) });

  await assert.rejects(
    () => scheduler.runJob(job.id, { handlers: { a: async () => {} }, nodeId: 'node-b' }),
    /already claimed/
  );
});

test('runDueJobs only runs jobs whose nextRunAt has passed, leaving future jobs untouched', async () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const now = new Date(2026, 7, 1);

  const dueJob = scheduler.addJob({
    type: 'a',
    schedule: { type: 'once', at: new Date(2026, 7, 1, 8, 0).toISOString() },
    now,
  });
  const futureJob = scheduler.addJob({
    type: 'a',
    schedule: { type: 'once', at: new Date(2026, 8, 1).toISOString() },
    now,
  });

  let calls = 0;
  const handlers = { a: async () => { calls += 1; } };
  const result = await scheduler.runDueJobs({ handlers, now: new Date(2026, 7, 1, 9, 0) });

  assert.strictEqual(result.ranCount, 1);
  assert.strictEqual(calls, 1);
  assert.strictEqual(scheduler.getJob(dueJob.id).status, 'completed');
  assert.strictEqual(scheduler.getJob(futureJob.id).status, 'scheduled', 'future job must not have run');
});

test('runDueJobs runs every due job in one pass, not just the first', async () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const now = new Date(2026, 7, 1);
  scheduler.addJob({ type: 'a', schedule: { type: 'once', at: new Date(2026, 6, 1).toISOString() }, now });
  scheduler.addJob({ type: 'a', schedule: { type: 'once', at: new Date(2026, 6, 15).toISOString() }, now });
  scheduler.addJob({ type: 'a', schedule: { type: 'once', at: new Date(2026, 8, 1).toISOString() }, now }); // not due

  let calls = 0;
  const result = await scheduler.runDueJobs({ handlers: { a: async () => { calls += 1; } }, now: new Date(2026, 7, 2) });
  assert.strictEqual(result.ranCount, 2);
  assert.strictEqual(calls, 2);
});

test('updateJob merges a patch into an existing job and recomputes nextRunAt only if the schedule changed', () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const job = scheduler.addJob({
    type: 'send-invoice',
    schedule: { type: 'monthly', dayOfMonth: 2 },
    params: { to: 'old@example.com' },
    now: new Date(2026, 7, 1),
  });
  const originalNextRunAt = job.nextRunAt;

  const withNewParams = scheduler.updateJob(job.id, { params: { to: 'new@example.com', subject: 'Invoice' } });
  assert.deepStrictEqual(withNewParams.params, { to: 'new@example.com', subject: 'Invoice' });
  assert.strictEqual(withNewParams.nextRunAt, originalNextRunAt, 'nextRunAt must be untouched when only params change');

  const withNewSchedule = scheduler.updateJob(
    job.id,
    { schedule: { type: 'monthly', dayOfMonth: 15 } },
    { now: new Date(2026, 7, 1) }
  );
  assert.strictEqual(new Date(withNewSchedule.nextRunAt).getDate(), 15);

  const withNewRetryPolicy = scheduler.updateJob(job.id, { retryPolicy: 'at-most-once' });
  assert.strictEqual(withNewRetryPolicy.retryPolicy, 'at-most-once');
});

test('addJob fixes attachments at creation time, defaulting to none', () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const withAttachments = scheduler.addJob({
    type: 'send-contract-email',
    schedule: { type: 'once', at: new Date(2026, 7, 2).toISOString() },
    now: new Date(2026, 7, 1),
    attachments: [{ filename: 'contract.pdf', mimeType: 'application/pdf', contentBase64: 'abc' }],
  });
  assert.strictEqual(withAttachments.attachments.length, 1);
  assert.strictEqual(withAttachments.attachments[0].filename, 'contract.pdf');

  const withoutAttachments = scheduler.addJob({
    type: 'a',
    schedule: { type: 'once', at: new Date(2026, 7, 2).toISOString() },
    now: new Date(2026, 7, 1),
  });
  assert.deepStrictEqual(withoutAttachments.attachments, []);
});

test('updateJob DLP guardrail: cannot alter attachments or type, even if asked to', () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const job = scheduler.addJob({
    type: 'send-contract-email',
    schedule: { type: 'once', at: new Date(2026, 7, 2).toISOString() },
    now: new Date(2026, 7, 1),
    attachments: [{ filename: 'contract.pdf', mimeType: 'application/pdf', contentBase64: 'abc' }],
  });

  const updated = scheduler.updateJob(job.id, {
    params: { to: 'new@example.com' },
    attachments: [{ filename: 'sneaked-in.pdf', mimeType: 'application/pdf', contentBase64: 'xyz' }],
    type: 'some-other-job-type',
  });

  assert.deepStrictEqual(updated.attachments, [{ filename: 'contract.pdf', mimeType: 'application/pdf', contentBase64: 'abc' }]);
  assert.strictEqual(updated.type, 'send-contract-email', 'a job can never be turned into a different job type via updateJob');
});

test('updateJob refuses to modify a cancelled job', () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const job = scheduler.addJob({
    type: 'a',
    schedule: { type: 'once', at: new Date(2026, 7, 2).toISOString() },
    now: new Date(2026, 7, 1),
  });
  scheduler.cancelJob(job.id);
  assert.throws(() => scheduler.updateJob(job.id, { params: { x: 1 } }), /is cancelled/);
});

test('cancelJob stops a job from ever running again', async () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const job = scheduler.addJob({
    type: 'a',
    schedule: { type: 'once', at: new Date(2026, 7, 1).toISOString() },
    now: new Date(2026, 6, 1),
  });

  scheduler.cancelJob(job.id);
  assert.strictEqual(scheduler.getJob(job.id).status, 'cancelled');
  assert.strictEqual(scheduler.getJob(job.id).nextRunAt, null);

  await assert.rejects(() => scheduler.runJob(job.id, { handlers: { a: async () => {} } }), /is cancelled/);

  const dueResult = await scheduler.runDueJobs({ handlers: { a: async () => {} }, now: new Date(2027, 0, 1) });
  assert.strictEqual(dueResult.ranCount, 0, 'a cancelled job must never be picked up by runDueJobs');
});

test('recordFeedback attaches feedback to a specific run without disturbing others', async () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const job = scheduler.addJob({
    type: 'a',
    schedule: { type: 'monthly', dayOfMonth: 2 },
    now: new Date(2026, 7, 1),
  });
  const handlers = { a: async () => 'ok' };
  await scheduler.runJob(job.id, { handlers, now: new Date(2026, 7, 2) });
  await scheduler.runJob(job.id, { handlers, now: new Date(2026, 8, 2) });

  const updated = scheduler.recordFeedback({ id: job.id, runIndex: 1, feedback: { approved: false, note: 'wrong amount' } });
  assert.strictEqual(updated.history[0].feedback, undefined, 'only the targeted run gets feedback');
  assert.deepStrictEqual(updated.history[1].feedback, { approved: false, note: 'wrong amount' });
});

// --- Distributed claim/lease/reclaim behavior ---

test('claimNextDueJob marks the job claimed with the claiming node and a lease expiry', () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const now = new Date(2026, 7, 1);
  scheduler.addJob({ type: 'a', schedule: { type: 'once', at: new Date(2026, 6, 1).toISOString() }, now });

  const claimed = scheduler.claimNextDueJob({ nodeId: 'node-a', now: new Date(2026, 7, 2), leaseMs: 60_000 });
  assert.strictEqual(claimed.status, 'claimed');
  assert.strictEqual(claimed.claimedBy, 'node-a');
  assert.strictEqual(new Date(claimed.leaseExpiresAt).getTime(), new Date(2026, 7, 2).getTime() + 60_000);
});

test('claimNextDueJob never lets two nodes claim the same job', () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const now = new Date(2026, 7, 1);
  scheduler.addJob({ type: 'a', schedule: { type: 'once', at: new Date(2026, 6, 1).toISOString() }, now });

  const claimedByA = scheduler.claimNextDueJob({ nodeId: 'node-a', now: new Date(2026, 7, 2) });
  const claimedByB = scheduler.claimNextDueJob({ nodeId: 'node-b', now: new Date(2026, 7, 2) });
  assert.ok(claimedByA);
  assert.strictEqual(claimedByB, null, 'a second claim attempt must find nothing left to claim');
});

test('claimNextDueJob moves on to the next candidate rather than returning null on the first unclaimable one', () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const now = new Date(2026, 7, 1);
  const first = scheduler.addJob({ type: 'a', schedule: { type: 'once', at: new Date(2026, 6, 1).toISOString() }, now });
  scheduler.addJob({ type: 'a', schedule: { type: 'once', at: new Date(2026, 6, 2).toISOString() }, now });

  scheduler.claimJob(first.id, { nodeId: 'node-a', now: new Date(2026, 7, 2) });
  const claimed = scheduler.claimNextDueJob({ nodeId: 'node-b', now: new Date(2026, 7, 2) });
  assert.ok(claimed, 'must still find the second due job even though the first was already claimed');
  assert.notStrictEqual(claimed.id, first.id);
});

test('completeJob refuses to complete a job claimed by a different node', () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const job = scheduler.addJob({ type: 'a', schedule: { type: 'monthly', dayOfMonth: 2 }, now: new Date(2026, 7, 1) });
  scheduler.claimJob(job.id, { nodeId: 'node-a', now: new Date(2026, 7, 2) });

  assert.throws(
    () => scheduler.completeJob({ id: job.id, nodeId: 'node-b', status: 'success', now: new Date(2026, 7, 2) }),
    /not claimed by node-b/
  );
});

test('reclaimStaleLeases releases an idempotent job back to scheduled so it is immediately reclaimable', () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const job = scheduler.addJob({
    type: 'a',
    schedule: { type: 'monthly', dayOfMonth: 2 },
    retryPolicy: 'idempotent',
    now: new Date(2026, 7, 1),
  });
  scheduler.claimJob(job.id, { nodeId: 'node-a', now: new Date(2026, 7, 2, 10, 0), leaseMs: 1000 }); // past the 9am due time
  const result = scheduler.reclaimStaleLeases({ now: new Date(2026, 7, 2, 10, 0, 5) }); // 5s later, past the 1s lease
  assert.strictEqual(result.releasedCount, 1);
  assert.strictEqual(result.stuckCount, 0);
  const reclaimed = scheduler.getJob(job.id);
  assert.strictEqual(reclaimed.status, 'scheduled');
  assert.strictEqual(reclaimed.claimedBy, null, 'the stale claim must be cleared');

  const reClaimed = scheduler.claimNextDueJob({ nodeId: 'node-b', now: new Date(2026, 7, 2, 10, 0, 6) });
  assert.ok(reClaimed, 'must be claimable again immediately after release');
});

test('reclaimStaleLeases marks an at-most-once job stuck instead of silently retrying it', () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const job = scheduler.addJob({
    type: 'send-monthly-invoice-email',
    schedule: { type: 'monthly', dayOfMonth: 2 },
    retryPolicy: 'at-most-once',
    now: new Date(2026, 7, 1),
  });
  scheduler.claimJob(job.id, { nodeId: 'node-a', now: new Date(2026, 7, 2), leaseMs: 1000 });

  const result = scheduler.reclaimStaleLeases({ now: new Date(2026, 7, 2, 0, 0, 5) });
  assert.strictEqual(result.releasedCount, 0);
  assert.strictEqual(result.stuckCount, 1);
  const stuck = scheduler.getJob(job.id);
  assert.strictEqual(stuck.status, 'stuck');

  const reClaimed = scheduler.claimNextDueJob({ nodeId: 'node-b', now: new Date(2026, 7, 2, 0, 0, 6) });
  assert.strictEqual(reClaimed, null, 'a stuck at-most-once job must never be auto-retried');
});

test('reclaimStaleLeases leaves a still-valid (not yet expired) lease alone', () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const job = scheduler.addJob({ type: 'a', schedule: { type: 'monthly', dayOfMonth: 2 }, now: new Date(2026, 7, 1) });
  scheduler.claimJob(job.id, { nodeId: 'node-a', now: new Date(2026, 7, 2), leaseMs: 60_000 });

  const result = scheduler.reclaimStaleLeases({ now: new Date(2026, 7, 2, 0, 0, 5) }); // well within the 60s lease
  assert.strictEqual(result.releasedCount, 0);
  assert.strictEqual(result.stuckCount, 0);
  assert.strictEqual(scheduler.getJob(job.id).status, 'claimed', 'a job still within its lease must not be touched');
});

test('addJob with schedule.type interval computes nextRunAt as now + minutes, and keeps recurring', async () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const now = new Date(2026, 7, 1, 12, 0, 0);
  const job = scheduler.addJob({ type: 'ping', schedule: { type: 'interval', minutes: 3 }, now });

  assert.strictEqual(job.nextRunAt, new Date(2026, 7, 1, 12, 3, 0).toISOString());

  const ranAt = new Date(2026, 7, 1, 12, 3, 0);
  const updated = await scheduler.runJob(job.id, { handlers: { ping: async () => ({ ok: true }) }, now: ranAt });
  assert.strictEqual(updated.status, 'scheduled', 'an interval job keeps recurring, same as monthly');
  assert.strictEqual(updated.nextRunAt, new Date(2026, 7, 1, 12, 6, 0).toISOString(), 'reschedules another `minutes` out from the run that just happened');
});

test('an interval schedule requires a positive minutes value', () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  assert.throws(
    () => scheduler.addJob({ type: 'ping', schedule: { type: 'interval', minutes: 0 }, now: new Date(2026, 7, 1) }),
    /positive minutes value/
  );
});

function jobWithReplyEntry(store) {
  const scheduler = new Scheduler({ store });
  const job = scheduler.addJob({ type: 'send-invoice', schedule: { type: 'monthly', dayOfMonth: 2 }, now: new Date(2026, 7, 1) });
  store.mutate(job.id, (j) => {
    j.history.push({ status: 'success', detail: { threadId: 'thread-1' } });
    return true;
  });
  return { scheduler, jobId: job.id };
}

test('claimReplyEntry lets one node claim a reply-bearing history entry, blocking a second node while the lease is live', () => {
  const store = fakeStore();
  const { scheduler, jobId } = jobWithReplyEntry(store);
  const now = new Date(2026, 7, 2, 9, 0);

  const claimed = scheduler.claimReplyEntry({ id: jobId, runIndex: 0, nodeId: 'node-a', now });
  assert.strictEqual(claimed.history[0].replyClaimedBy, 'node-a');

  assert.throws(
    () => scheduler.claimReplyEntry({ id: jobId, runIndex: 0, nodeId: 'node-b', now: new Date(now.getTime() + 1000) }),
    /already claimed by node-a/
  );
});

test('claimReplyEntry lets a second node take over once the first node\'s lease has expired (failover)', () => {
  const store = fakeStore();
  const { scheduler, jobId } = jobWithReplyEntry(store);
  const now = new Date(2026, 7, 2, 9, 0);

  scheduler.claimReplyEntry({ id: jobId, runIndex: 0, nodeId: 'node-a', now, leaseMs: 60_000 });

  const wellAfterExpiry = new Date(now.getTime() + 120_000);
  const reclaimed = scheduler.claimReplyEntry({ id: jobId, runIndex: 0, nodeId: 'node-b', now: wellAfterExpiry });
  assert.strictEqual(
    reclaimed.history[0].replyClaimedBy,
    'node-b',
    'a node that crashed/hung mid-resolution must not permanently block another node from ever picking this up'
  );
});

test('claimReplyEntry lets the same node re-claim (e.g. re-checking after a retry) without error', () => {
  const store = fakeStore();
  const { scheduler, jobId } = jobWithReplyEntry(store);
  const now = new Date(2026, 7, 2, 9, 0);

  scheduler.claimReplyEntry({ id: jobId, runIndex: 0, nodeId: 'node-a', now });
  const reclaimedBySame = scheduler.claimReplyEntry({ id: jobId, runIndex: 0, nodeId: 'node-a', now: new Date(now.getTime() + 1000) });
  assert.strictEqual(reclaimedBySame.history[0].replyClaimedBy, 'node-a');
});

test('recordFeedback releases the reply claim once resolved', () => {
  const store = fakeStore();
  const { scheduler, jobId } = jobWithReplyEntry(store);
  scheduler.claimReplyEntry({ id: jobId, runIndex: 0, nodeId: 'node-a' });

  const updated = scheduler.recordFeedback({ id: jobId, runIndex: 0, feedback: { outcome: 'approved' } });
  assert.strictEqual(updated.history[0].replyClaimedBy, null);
  assert.strictEqual(updated.history[0].replyClaimedAt, null);
  assert.strictEqual(updated.history[0].replyLeaseExpiresAt, null);
});
