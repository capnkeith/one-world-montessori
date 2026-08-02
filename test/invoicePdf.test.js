'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildInvoicePdf } = require('../src/core/invoicePdf');

async function extractText(pdfBuffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: pdfBuffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy?.();
  }
}

test('produces a real PDF (magic bytes) with the invoice number, date, and bill-to in its actual text content', async () => {
  const pdfBuffer = await buildInvoicePdf({
    invoiceNumber: 'OWM-INV-000042',
    invoiceDate: 'August 2, 2026',
    billTo: 'One World Montessori — Business Office',
    lineItems: [{ description: 'OWM Claude Tools Platform — Monthly Automation', amount: 0 }],
  });

  assert.ok(Buffer.isBuffer(pdfBuffer));
  assert.strictEqual(pdfBuffer.subarray(0, 5).toString('utf8'), '%PDF-');

  const text = await extractText(pdfBuffer);
  assert.match(text, /OWM-INV-000042/);
  assert.match(text, /August 2, 2026/);
  assert.match(text, /Business Office/);
  assert.match(text, /Monthly Automation/);
});

test('the total is the sum of all line items, not just the first', async () => {
  const pdfBuffer = await buildInvoicePdf({
    invoiceNumber: 'OWM-INV-000001',
    invoiceDate: 'January 1, 2026',
    billTo: 'Someone',
    lineItems: [
      { description: 'Item A', amount: 12.5 },
      { description: 'Item B', amount: 7.5 },
    ],
  });

  const text = await extractText(pdfBuffer);
  assert.match(text, /Item A/);
  assert.match(text, /Item B/);
  assert.match(text, /\$20\.00/, 'total must be the sum (12.50 + 7.50), not one line item alone');
});

test('renders without a logo just fine (logoBuffer is optional)', async () => {
  const pdfBuffer = await buildInvoicePdf({
    invoiceNumber: 'OWM-INV-000002',
    invoiceDate: 'January 1, 2026',
    billTo: 'Someone',
    lineItems: [{ description: 'Thing', amount: 1 }],
  });
  assert.strictEqual(pdfBuffer.subarray(0, 5).toString('utf8'), '%PDF-');
});
