'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildJobHandlers } = require('../src/tools/jobHandlers');

function fakeMailTool({ messages = [] } = {}) {
  const calls = [];
  return {
    calls,
    invoke: async (params) => {
      calls.push(params);
      if (params.action === 'listMessages') {
        return { result: { messages } };
      }
      if (params.action === 'forward') {
        return { result: { sent: true, id: 'sent-1', threadId: params.threadId ?? 'new-thread' } };
      }
      if (params.action === 'send') {
        return { result: { sent: true, id: 'sent-2', threadId: 'thread-x' } };
      }
      throw new Error(`unexpected mail action ${params.action}`);
    },
  };
}

function fakeSchedulerTool(initialJobs = []) {
  const jobs = [...initialJobs];
  const calls = [];
  let nextId = 1;
  return {
    jobs,
    calls,
    invoke: async (params) => {
      calls.push(params);
      if (params.action === 'listJobs') return { result: { jobs } };
      if (params.action === 'addJob') {
        const job = { id: `pester-${nextId++}`, status: 'scheduled', history: [], ...params };
        jobs.push(job);
        return { result: job };
      }
      if (params.action === 'runJob') return { result: { ranJobId: params.id } };
      if (params.action === 'cancelJob') {
        const job = jobs.find((j) => j.id === params.id);
        if (job) job.status = 'cancelled';
        return { result: job };
      }
      throw new Error(`unexpected scheduler action ${params.action}`);
    },
  };
}

test('send-monthly-invoice-email forwards the latest matching message as-is when one is found', async () => {
  const mailTool = fakeMailTool({ messages: [{ id: 'msg-1', threadId: 'thread-1' }] });
  const schedulerTool = fakeSchedulerTool();
  const handlers = buildJobHandlers({ getMailTool: () => mailTool, getSchedulerTool: () => schedulerTool });

  const job = { id: 'job-1', label: 'Monthly invoice', history: [] };
  const result = await handlers['send-monthly-invoice-email']({ to: 'businessmanager@oneworldmontessori.org' }, job);

  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.forwardedMessageId, 'msg-1');
  const listCall = mailTool.calls.find((c) => c.action === 'listMessages');
  assert.match(listCall.query, /anthropic/);
  const forwardCall = mailTool.calls.find((c) => c.action === 'forward');
  assert.strictEqual(forwardCall.id, 'msg-1');
  assert.strictEqual(forwardCall.to, 'businessmanager@oneworldmontessori.org');
  assert.deepStrictEqual(forwardCall.cc, ['seth@oneworldmontessori.org']);
  assert.strictEqual(schedulerTool.calls.length, 0, 'must never touch the scheduler when the invoice was found immediately');
});

test('send-monthly-invoice-email threads into the last successful run\'s conversation instead of starting fresh', async () => {
  const mailTool = fakeMailTool({ messages: [{ id: 'msg-2', threadId: 'thread-2' }] });
  const schedulerTool = fakeSchedulerTool();
  const handlers = buildJobHandlers({ getMailTool: () => mailTool, getSchedulerTool: () => schedulerTool });

  const job = {
    id: 'job-1',
    label: 'Monthly invoice',
    history: [{ status: 'success', detail: { threadId: 'existing-thread' } }],
  };
  await handlers['send-monthly-invoice-email']({ to: 'a@b.com' }, job);

  const forwardCall = mailTool.calls.find((c) => c.action === 'forward');
  assert.strictEqual(forwardCall.threadId, 'existing-thread');
});

test('send-monthly-invoice-email starts a daily pester job and runs it immediately when nothing is found', async () => {
  const mailTool = fakeMailTool({ messages: [] });
  const schedulerTool = fakeSchedulerTool();
  const handlers = buildJobHandlers({ getMailTool: () => mailTool, getSchedulerTool: () => schedulerTool });

  const job = { id: 'job-1', label: 'Monthly invoice', history: [] };
  const result = await handlers['send-monthly-invoice-email']({ to: 'businessmanager@oneworldmontessori.org' }, job);

  assert.strictEqual(result.sent, false);
  const addCall = schedulerTool.calls.find((c) => c.action === 'addJob');
  assert.ok(addCall, 'must create a pester job');
  assert.strictEqual(addCall.type, 'pester-for-missing-invoice');
  assert.strictEqual(addCall.schedule.type, 'interval');
  assert.strictEqual(addCall.params.parentJobId, 'job-1');
  const runCall = schedulerTool.calls.find((c) => c.action === 'runJob');
  assert.ok(runCall, 'must fire the first reminder today, not wait a full day');
});

test('send-monthly-invoice-email reuses an existing pester job instead of creating a duplicate', async () => {
  const mailTool = fakeMailTool({ messages: [] });
  const existingPester = {
    id: 'pester-existing',
    type: 'pester-for-missing-invoice',
    status: 'scheduled',
    params: { parentJobId: 'job-1' },
    history: [],
  };
  const schedulerTool = fakeSchedulerTool([existingPester]);
  const handlers = buildJobHandlers({ getMailTool: () => mailTool, getSchedulerTool: () => schedulerTool });

  await handlers['send-monthly-invoice-email']({ to: 'a@b.com' }, { id: 'job-1', label: 'Monthly invoice', history: [] });

  assert.strictEqual(schedulerTool.calls.filter((c) => c.action === 'addJob').length, 0, 'must not create a second pester job');
  const runCall = schedulerTool.calls.find((c) => c.action === 'runJob');
  assert.strictEqual(runCall.id, 'pester-existing');
});

test('pester-for-missing-invoice forwards and cancels itself the moment the invoice shows up', async () => {
  const mailTool = fakeMailTool({ messages: [{ id: 'msg-3', threadId: 'thread-3' }] });
  const schedulerTool = fakeSchedulerTool();
  const handlers = buildJobHandlers({ getMailTool: () => mailTool, getSchedulerTool: () => schedulerTool });

  const job = { id: 'pester-1', params: { to: 'businessmanager@oneworldmontessori.org' }, history: [] };
  const result = await handlers['pester-for-missing-invoice'](job.params, job);

  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.stoppedPestering, true);
  const cancelCall = schedulerTool.calls.find((c) => c.action === 'cancelJob');
  assert.strictEqual(cancelCall.id, 'pester-1');
  assert.strictEqual(
    mailTool.calls.some((c) => c.action === 'send'),
    false,
    'must not also send a pester email once the real invoice was found'
  );
});

test('pester-for-missing-invoice emails the pester list when still nothing is found', async () => {
  const mailTool = fakeMailTool({ messages: [] });
  const schedulerTool = fakeSchedulerTool();
  const handlers = buildJobHandlers({ getMailTool: () => mailTool, getSchedulerTool: () => schedulerTool });

  const job = { id: 'pester-1', params: { to: 'businessmanager@oneworldmontessori.org' }, history: [] };
  const result = await handlers['pester-for-missing-invoice'](job.params, job);

  assert.strictEqual(result.sent, false);
  const sendCall = mailTool.calls.find((c) => c.action === 'send');
  assert.ok(sendCall);
  assert.match(sendCall.to, /seth@oneworldmontessori\.org/);
  assert.match(sendCall.to, /seth\.keith@citrix\.com/);
  assert.strictEqual(schedulerTool.calls.some((c) => c.action === 'cancelJob'), false, 'must not cancel itself while still missing');
});

test('send-recurring-test-email sends a plain no-attachment email with sensible defaults', async () => {
  const mailTool = fakeMailTool();
  const schedulerTool = fakeSchedulerTool();
  const handlers = buildJobHandlers({ getMailTool: () => mailTool, getSchedulerTool: () => schedulerTool });

  await handlers['send-recurring-test-email']({ to: 'seth@oneworldmontessori.org' });

  const sendCall = mailTool.calls.find((c) => c.action === 'send');
  assert.strictEqual(sendCall.to, 'seth@oneworldmontessori.org');
  assert.strictEqual(sendCall.subject, 'Recurring test email');
  assert.match(sendCall.text, /reply stop/i);
  assert.strictEqual(sendCall.attachments, undefined, 'no attachments at all, not even an empty array requiring a source tag');
});
