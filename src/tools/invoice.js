'use strict';

const assert = require('node:assert');
const { z } = require('zod');
const { Tool } = require('../core/Tool');

/**
 * Business-logic layer on top of the generic `pdf` tool: owns the
 * auto-incrementing invoice number (via `invoiceCounter`,
 * src/core/InvoiceCounter.js), the OWM logo asset, and sensible
 * defaults (a clearly-labeled demonstration line item when none is
 * supplied). Composes `pdf` via ctx.call rather than rendering PDFs
 * itself - same layering as disputeResolver composing scheduler/mail/
 * claude, or claude composing drive/channel.
 */
function createInvoiceTool({ invoiceCounter, logoBuffer, getPdfTool, now = () => new Date() }) {
  return new Tool({
    name: 'invoice',
    version: '1.0.0',
    description: 'Generates a real invoice PDF with an auto-incrementing invoice number and the OWM logo.',
    mcpInputSchema: {
      action: z.enum(['build']).optional(),
      invoiceNumber: z.string().optional(),
      billTo: z.string().optional(),
      lineItems: z.array(z.object({ description: z.string(), amount: z.number() })).optional(),
    },

    run: async (params, ctx) => {
      const action = params?.action ?? 'build';

      if (action === 'build') {
        const invoiceNumber = params?.invoiceNumber ?? invoiceCounter.next();
        const invoiceDate = now().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        const billTo = params?.billTo ?? 'One World Montessori — Business Office';
        const lineItems = params?.lineItems ?? [
          { description: 'OWM Claude Tools Platform — Monthly Automation (Demonstration Invoice, no payment due)', amount: 0 },
        ];

        const { result } = await ctx.call(getPdfTool(), {
          action: 'renderInvoiceLayout',
          invoiceNumber,
          invoiceDate,
          billTo,
          lineItems,
          logoBase64: logoBuffer ? logoBuffer.toString('base64') : undefined,
        });

        return {
          invoiceNumber,
          filename: `${invoiceNumber}.pdf`,
          mimeType: 'application/pdf',
          contentBase64: result.contentBase64,
        };
      }

      throw new Error(`Unknown invoice action: ${action}`);
    },

    // Fakes only the pdf tool (so this test is fast/isolated and never
    // depends on real pdf-lib rendering) - proves the numbering/defaults
    // logic, not PDF content. Real end-to-end rendering (including the
    // logo) is covered in test/invoice.test.js against a real pdf tool.
    internalTest: async () => {
      let calls = 0;
      const fakeCounter = {
        next: () => {
          calls += 1;
          return `OWM-INV-TEST${calls}`;
        },
      };
      const fakePdfTool = {
        invoke: async () => ({ result: { mimeType: 'application/pdf', contentBase64: 'ZmFrZQ==' }, versionLineage: [] }),
      };
      const fakeTool = createInvoiceTool({ invoiceCounter: fakeCounter, getPdfTool: () => fakePdfTool });

      const auto = await fakeTool.invoke({
        action: 'build',
        billTo: 'Someone',
        lineItems: [{ description: 'A thing', amount: 5 }],
      });
      assert.strictEqual(auto.result.invoiceNumber, 'OWM-INV-TEST1');
      assert.strictEqual(auto.result.filename, 'OWM-INV-TEST1.pdf');

      const explicit = await fakeTool.invoke({ action: 'build', invoiceNumber: 'OWM-INV-000042' });
      assert.strictEqual(explicit.result.invoiceNumber, 'OWM-INV-000042');
      assert.strictEqual(calls, 1, 'an explicit invoiceNumber must not consume a new counter value');

      return { passed: true };
    },

    realWorldTest: async (testConfig, { call }) => {
      const { result } = await call({ action: 'build', invoiceNumber: 'OWM-INV-REALWORLDTEST' });
      assert.ok(result.contentBase64);
      return { passed: true, checkedAgainst: testConfig.label ?? 'unnamed-fixture' };
    },
  });
}

module.exports = { createInvoiceTool };
