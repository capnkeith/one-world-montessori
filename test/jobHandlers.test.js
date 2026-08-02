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
