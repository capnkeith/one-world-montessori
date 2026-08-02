'use strict';

const assert = require('node:assert');
const { z } = require('zod');
const { Tool } = require('../core/Tool');
const { buildInvoicePdf } = require('../core/invoicePdf');

/**
 * Generic real-PDF-rendering primitive - no business logic (no invoice
 * numbering, no defaults, no logo asset ownership), just "given these
 * exact fields, produce PDF bytes." Kept separate from `invoice` (which
 * owns numbering/defaults/the logo asset and calls this tool to do the
 * actual rendering) so future document types can add new render actions
 * here without the business-logic layer needing to change.
 */
function createPdfTool() {
  return new Tool({
    name: 'pdf',
    version: '1.0.0',
    description: 'Generic real PDF rendering - currently an invoice-shaped layout (logo, invoice #/date, bill-to, line-item table, total).',
    mcpInputSchema: {
      action: z.enum(['renderInvoiceLayout']).optional(),
      invoiceNumber: z.string().optional(),
      invoiceDate: z.string().optional(),
      billTo: z.string().optional(),
      lineItems: z.array(z.object({ description: z.string(), amount: z.number() })).optional(),
      logoBase64: z.string().optional(),
    },

    run: async (params) => {
      const action = params?.action ?? 'renderInvoiceLayout';

      if (action === 'renderInvoiceLayout') {
        const logoBuffer = params.logoBase64 ? Buffer.from(params.logoBase64, 'base64') : null;
        const pdfBuffer = await buildInvoicePdf({
          invoiceNumber: params.invoiceNumber,
          invoiceDate: params.invoiceDate,
          billTo: params.billTo,
          lineItems: params.lineItems,
          logoBuffer,
        });
        return { mimeType: 'application/pdf', contentBase64: pdfBuffer.toString('base64') };
      }

      throw new Error(`Unknown pdf action: ${action}`);
    },

    internalTest: async ({ call }) => {
      const { result } = await call({
        action: 'renderInvoiceLayout',
        invoiceNumber: 'OWM-INV-TEST',
        invoiceDate: 'January 1, 2026',
        billTo: 'Someone',
        lineItems: [{ description: 'A thing', amount: 5 }],
      });
      const bytes = Buffer.from(result.contentBase64, 'base64');
      assert.strictEqual(bytes.subarray(0, 5).toString('utf8'), '%PDF-');
      return { passed: true };
    },

    // No external network/credentials involved (pure local rendering),
    // so unlike drive/dropbox/mail this needs no testConfig gate.
    realWorldTest: async (testConfig, { call }) => {
      const { result } = await call({
        action: 'renderInvoiceLayout',
        invoiceNumber: 'x',
        invoiceDate: 'x',
        billTo: 'x',
        lineItems: [{ description: 'x', amount: 1 }],
      });
      assert.ok(result.contentBase64);
      return { passed: true, checkedAgainst: testConfig.label ?? 'unnamed-fixture' };
    },
  });
}

module.exports = { createPdfTool };
