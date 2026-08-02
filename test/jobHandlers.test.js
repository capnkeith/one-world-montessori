'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildJobHandlers } = require('../src/tools/jobHandlers');

function fakeInvoiceCounter(startAt = 0) {
  let n = startAt;
  return {
    next: () => {
      n += 1;
      return `OWM-INV-${String(n).padStart(6, '0')}`;
    },
  };
}

test('send-monthly-invoice-email generates a real PDF and sends it with an incrementing invoice number', async () => {
  const sentParams = [];
  const fakeMailTool = {
    invoke: async (params) => {
      sentParams.push(params);
      return { result: { sent: true, id: 'msg-1', threadId: 'thread-1' } };
    },
  };
  const handlers = buildJobHandlers({
    getMailTool: () => fakeMailTool,
    invoiceCounter: fakeInvoiceCounter(),
    now: () => new Date(2026, 7, 2),
  });

  const result = await handlers['send-monthly-invoice-email']({ to: 'businessmanager@oneworldmontessori.org' });

  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.invoiceNumber, 'OWM-INV-000001');
  assert.strictEqual(sentParams.length, 1);
  assert.strictEqual(sentParams[0].to, 'businessmanager@oneworldmontessori.org');
  assert.match(sentParams[0].subject, /OWM-INV-000001/);
  assert.strictEqual(sentParams[0].attachments.length, 1);
  assert.strictEqual(sentParams[0].attachments[0].filename, 'OWM-INV-000001.pdf');
  assert.strictEqual(sentParams[0].attachments[0].mimeType, 'application/pdf');
  const pdfBytes = Buffer.from(sentParams[0].attachments[0].contentBase64, 'base64');
  assert.strictEqual(pdfBytes.subarray(0, 5).toString('utf8'), '%PDF-');
});

test('always cc\'s Seth, merging with whatever cc list a job already has', async () => {
  const sentParams = [];
  const fakeMailTool = {
    invoke: async (params) => {
      sentParams.push(params);
      return { result: { sent: true } };
    },
  };
  const handlers = buildJobHandlers({ getMailTool: () => fakeMailTool, invoiceCounter: fakeInvoiceCounter() });

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
  const handlers = buildJobHandlers({ getMailTool: () => fakeMailTool, invoiceCounter: fakeInvoiceCounter() });

  const first = await handlers['send-monthly-invoice-email']({ to: 'a@b.com' });
  const second = await handlers['send-monthly-invoice-email']({ to: 'a@b.com' });
  assert.strictEqual(first.invoiceNumber, 'OWM-INV-000001');
  assert.strictEqual(second.invoiceNumber, 'OWM-INV-000002');
});

test('a job can override billTo and lineItems via params instead of the demo default', async () => {
  const sentParams = [];
  const fakeMailTool = {
    invoke: async (params) => {
      sentParams.push(params);
      return { result: { sent: true } };
    },
  };
  const handlers = buildJobHandlers({ getMailTool: () => fakeMailTool, invoiceCounter: fakeInvoiceCounter() });

  await handlers['send-monthly-invoice-email']({
    to: 'a@b.com',
    billTo: 'Some Real Client',
    lineItems: [{ description: 'Real service', amount: 150 }],
  });

  const pdfBytes = Buffer.from(sentParams[0].attachments[0].contentBase64, 'base64');
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: pdfBytes });
  const { text } = await parser.getText();
  await parser.destroy?.();
  assert.match(text, /Some Real Client/);
  assert.match(text, /Real service/);
  assert.match(text, /\$150\.00/);
});
