'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createInvoiceTool } = require('../src/tools/invoice');
const { createPdfTool } = require('../src/tools/pdf');

function fakeCounter(startAt = 0) {
  let n = startAt;
  return { next: () => `OWM-INV-${String(++n).padStart(6, '0')}` };
}

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

// This file exercises invoice + a REAL pdf tool together (not a fake) -
// invoice.js's own internalTest fakes the pdf tool for isolation; this
// is the full-integration coverage, including the real logo.

test('build auto-assigns the next invoice number and produces a real PDF', async () => {
  const tool = createInvoiceTool({ invoiceCounter: fakeCounter(), getPdfTool: () => createPdfTool() });
  const { result } = await tool.invoke({
    action: 'build',
    billTo: 'Someone',
    lineItems: [{ description: 'A real thing', amount: 12.5 }],
  });

  assert.strictEqual(result.invoiceNumber, 'OWM-INV-000001');
  assert.strictEqual(result.filename, 'OWM-INV-000001.pdf');
  assert.strictEqual(result.mimeType, 'application/pdf');
  const pdfBytes = Buffer.from(result.contentBase64, 'base64');
  assert.strictEqual(pdfBytes.subarray(0, 5).toString('utf8'), '%PDF-');

  const text = await extractText(pdfBytes);
  assert.match(text, /OWM-INV-000001/);
  assert.match(text, /Someone/);
  assert.match(text, /A real thing/);
  assert.match(text, /\$12\.50/);
});

test('each build advances the counter, never repeating a number', async () => {
  const tool = createInvoiceTool({ invoiceCounter: fakeCounter(), getPdfTool: () => createPdfTool() });
  const first = await tool.invoke({ action: 'build' });
  const second = await tool.invoke({ action: 'build' });
  assert.strictEqual(first.result.invoiceNumber, 'OWM-INV-000001');
  assert.strictEqual(second.result.invoiceNumber, 'OWM-INV-000002');
});

test('an explicit invoiceNumber overrides the counter and does not consume a new value', async () => {
  const counter = fakeCounter();
  const tool = createInvoiceTool({ invoiceCounter: counter, getPdfTool: () => createPdfTool() });

  const explicit = await tool.invoke({ action: 'build', invoiceNumber: 'OWM-INV-CUSTOM' });
  assert.strictEqual(explicit.result.invoiceNumber, 'OWM-INV-CUSTOM');

  const next = await tool.invoke({ action: 'build' });
  assert.strictEqual(next.result.invoiceNumber, 'OWM-INV-000001', 'the counter must not have been touched by the explicit call');
});

test('defaults to a clearly-labeled demonstration line item when none is supplied', async () => {
  const tool = createInvoiceTool({ invoiceCounter: fakeCounter(), getPdfTool: () => createPdfTool() });
  const { result } = await tool.invoke({ action: 'build' });
  const text = await extractText(Buffer.from(result.contentBase64, 'base64'));
  assert.match(text, /Demonstration Invoice, no payment due/);
  assert.match(text, /\$0\.00/);
});

test('embeds the real OWM logo without corrupting it (regression: pdfkit\'s image bug, fixed by switching to pdf-lib)', async () => {
  const logoBuffer = fs.readFileSync(path.join(__dirname, '..', 'assets', 'owm-logo.jpg'));
  const tool = createInvoiceTool({ invoiceCounter: fakeCounter(), logoBuffer, getPdfTool: () => createPdfTool() });
  const { result } = await tool.invoke({ action: 'build' });
  const pdfBytes = Buffer.from(result.contentBase64, 'base64');

  // The embedded JPEG must be byte-identical to the source file - proves
  // the image data itself was never touched/re-encoded/corrupted.
  const soi = pdfBytes.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  const eoi = pdfBytes.indexOf(Buffer.from([0xff, 0xd9]), soi);
  const embedded = pdfBytes.subarray(soi, eoi + 2);
  assert.strictEqual(Buffer.compare(embedded, logoBuffer), 0);
});
