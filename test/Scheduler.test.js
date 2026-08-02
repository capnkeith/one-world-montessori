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

test('addJob computes nextRunAt from the schedule and defaults to status scheduled', () => {
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
  assert.strictEqual(new Date(job.nextRunAt).getDate(), 2);
  assert.strictEqual(job.history.length, 0);
});

test('runJob executes the registered handler, records history, and reschedules a recurring job', async () => {
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
  assert.strictEqual(updated.lastRunAt, ranAt.toISOString());
  assert.strictEqual(updated.status, 'scheduled', 'a recurring job stays scheduled after running');
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

test('runJob throws a clear error when no handler is registered for the job type', async () => {
  const scheduler = new Scheduler({ store: fakeStore() });
  const job = scheduler.addJob({
    type: 'send-invoice',
    schedule: { type: 'monthly', dayOfMonth: 2 },
    now: new Date(2026, 7, 1),
  });

  await assert.rejects(() => scheduler.runJob(job.id, { handlers: {} }), /No handler registered/);
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
