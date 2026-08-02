'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildJobHandlers } = require('../src/tools/jobHandlers');

function fakeInvoiceTool(startAt = 0) {
  let n = startAt;
  const calls = [];
  return {
    calls,
    invoke: async (params) => {
      calls.push(params);
      n += 1;
      const invoiceNumber = `OWM-INV-${String(n).padStart(6, '0')}`;
      return {
        result: {
          invoiceNumber,
          filename: `${invoiceNumber}.pdf`,
          mimeType: 'application/pdf',
          contentBase64: Buffer.from('%PDF-fake').toString('base64'),
        },
      };
    },
  };
}

test('send-monthly-invoice-email builds an invoice via the invoice tool and emails it with an incrementing number', async () => {
  const sentParams = [];
  const fakeMailTool = {
    invoke: async (params) => {
      sentParams.push(params);
      return { result: { sent: true, id: 'msg-1', threadId: 'thread-1' } };
    },
  };
  const invoiceTool = fakeInvoiceTool();
  const handlers = buildJobHandlers({ getMailTool: () => fakeMailTool, getInvoiceTool: () => invoiceTool });

  const result = await handlers['send-monthly-invoice-email']({ to: 'businessmanager@oneworldmontessori.org' });

  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.invoiceNumber, 'OWM-INV-000001');
  assert.strictEqual(invoiceTool.calls.length, 1);
  assert.strictEqual(invoiceTool.calls[0].action, 'build');
  assert.strictEqual(sentParams.length, 1);
  assert.strictEqual(sentParams[0].to, 'businessmanager@oneworldmontessori.org');
  assert.match(sentParams[0].subject, /OWM-INV-000001/);
  assert.strictEqual(sentParams[0].attachments.length, 1);
  assert.strictEqual(sentParams[0].attachments[0].filename, 'OWM-INV-000001.pdf');
  assert.strictEqual(sentParams[0].attachments[0].mimeType, 'application/pdf');
  assert.strictEqual(
    sentParams[0].attachments[0].source,
    'rendered',
    'the invoice tool built this fresh from structured params, never from Drive — mail.js requires this tag'
  );
});

test('DLP guardrail: job-defined attachments (fixed on the job at creation) are forwarded and tagged job-defined', async () => {
  const sentParams = [];
  const fakeMailTool = {
    invoke: async (params) => {
      sentParams.push(params);
      return { result: { sent: true } };
    },
  };
  const handlers = buildJobHandlers({ getMailTool: () => fakeMailTool, getInvoiceTool: () => fakeInvoiceTool() });

  const job = {
    id: 'job-1',
    attachments: [{ filename: 'contract.pdf', mimeType: 'application/pdf', contentBase64: 'abc' }],
  };
  await handlers['send-monthly-invoice-email']({ to: 'a@b.com' }, job);

  assert.strictEqual(sentParams[0].attachments.length, 2, 'rendered invoice plus the job-defined attachment');
  const jobDefined = sentParams[0].attachments.find((a) => a.filename === 'contract.pdf');
  assert.ok(jobDefined);
  assert.strictEqual(jobDefined.source, 'job-defined');
});

test('with no job argument at all (real-world runJob always passes one), job-defined attachments default to none', async () => {
  const sentParams = [];
  const fakeMailTool = {
    invoke: async (params) => {
      sentParams.push(params);
      return { result: { sent: true } };
    },
  };
  const handlers = buildJobHandlers({ getMailTool: () => fakeMailTool, getInvoiceTool: () => fakeInvoiceTool() });

  await handlers['send-monthly-invoice-email']({ to: 'a@b.com' });
  assert.strictEqual(sentParams[0].attachments.length, 1, 'just the rendered invoice, no job-defined attachments to forward');
});

test('always cc\'s Seth, merging with whatever cc list a job already has', async () => {
  const sentParams = [];
  const fakeMailTool = {
    invoke: async (params) => {
      sentParams.push(params);
      return { result: { sent: true } };
    },
  };
  const handlers = buildJobHandlers({ getMailTool: () => fakeMailTool, getInvoiceTool: () => fakeInvoiceTool() });

  await handlers['send-monthly-invoice-email']({ to: 'a@b.com' });
  assert.deepStrictEqual(sentParams[0].cc, ['seth@oneworldmontessori.org']);

  await handlers['send-monthly-invoice-email']({ to: 'a@b.com', cc: 'rebecca@oneworldmontessori.org' });
  assert.deepStrictEqual(sentParams[1].cc, ['rebecca@oneworldmontessori.org', 'seth@oneworldmontessori.org']);

  await handlers['send-monthly-invoice-email']({ to: 'a@b.com', cc: ['rebecca@oneworldmontessori.org', 'seth@oneworldmontessori.org'] });
  assert.deepStrictEqual(
    sentParams[2].cc,
    ['rebecca@oneworldmontessori.org', 'seth@oneworldmontessori.org'],
    'must not duplicate Seth if he is already in the list'
  );
});

test('each run gets the next invoice number, not a repeat', async () => {
  const fakeMailTool = { invoke: async () => ({ result: { sent: true } }) };
  const invoiceTool = fakeInvoiceTool();
  const handlers = buildJobHandlers({ getMailTool: () => fakeMailTool, getInvoiceTool: () => invoiceTool });

  const first = await handlers['send-monthly-invoice-email']({ to: 'a@b.com' });
  const second = await handlers['send-monthly-invoice-email']({ to: 'a@b.com' });
  assert.strictEqual(first.invoiceNumber, 'OWM-INV-000001');
  assert.strictEqual(second.invoiceNumber, 'OWM-INV-000002');
});

test('billTo and lineItems from job params are passed through to the invoice tool', async () => {
  const invoiceTool = fakeInvoiceTool();
  const fakeMailTool = { invoke: async () => ({ result: { sent: true } }) };
  const handlers = buildJobHandlers({ getMailTool: () => fakeMailTool, getInvoiceTool: () => invoiceTool });

  await handlers['send-monthly-invoice-email']({
    to: 'a@b.com',
    billTo: 'Some Real Client',
    lineItems: [{ description: 'Real service', amount: 150 }],
  });

  assert.strictEqual(invoiceTool.calls[0].billTo, 'Some Real Client');
  assert.deepStrictEqual(invoiceTool.calls[0].lineItems, [{ description: 'Real service', amount: 150 }]);
});

test('send-recurring-test-email sends a plain no-attachment email with sensible defaults', async () => {
  const sentParams = [];
  const fakeMailTool = {
    invoke: async (params) => {
      sentParams.push(params);
      return { result: { sent: true } };
    },
  };
  const handlers = buildJobHandlers({ getMailTool: () => fakeMailTool, getInvoiceTool: () => fakeInvoiceTool() });

  await handlers['send-recurring-test-email']({ to: 'seth@oneworldmontessori.org' });

  assert.strictEqual(sentParams[0].to, 'seth@oneworldmontessori.org');
  assert.strictEqual(sentParams[0].subject, 'Recurring test email');
  assert.match(sentParams[0].text, /reply stop/i);
  assert.strictEqual(sentParams[0].attachments, undefined, 'no attachments at all, not even an empty array requiring a source tag');
});
