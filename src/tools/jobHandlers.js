'use strict';

const { buildInvoicePdf } = require('../core/invoicePdf');

const DEFAULT_LINE_ITEMS = [
  {
    description: 'OWM Claude Tools Platform — Monthly Automation (Demonstration Invoice, no payment due)',
    amount: 0,
  },
];

function formatInvoiceDate(date) {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Seth wants to be cc'd on all correspondence this system sends, not just
// this job's original recipients — merged in regardless of what's already
// in job.params.cc, deduped so re-running an already-updated job doesn't
// double him up.
const STANDING_CC = 'seth@oneworldmontessori.org';

function withStandingCc(cc) {
  const existing = cc ? (Array.isArray(cc) ? cc : [cc]) : [];
  return existing.includes(STANDING_CC) ? existing : [...existing, STANDING_CC];
}

/**
 * Real job-type handlers for the `scheduler` tool, kept separate from the
 * scheduling mechanism itself (src/core/Scheduler.js, src/tools/scheduler.js)
 * so adding a new job type never touches scheduling logic.
 *
 * `send-monthly-invoice-email` (2026-08-02) generates a real PDF invoice
 * on every run — a fresh incrementing number from `invoiceCounter`
 * (src/core/InvoiceCounter.js), the OWM logo, a bill-to, and line items —
 * then sends it via the `mail` tool. Line items/amount default to a
 * clearly-labeled demonstration entry (no real dollar figure fabricated)
 * since job.params doesn't have to carry real billing content every
 * month; a future run can override description/billTo/lineItems via
 * job.params if real billing content is ever supplied.
 */
function buildJobHandlers({ getMailTool, invoiceCounter, logoBuffer, now = () => new Date() }) {
  return {
    'send-monthly-invoice-email': async (params) => {
      const invoiceNumber = invoiceCounter.next();
      const invoiceDate = formatInvoiceDate(now());
      const billTo = params?.billTo ?? 'One World Montessori — Business Office';
      const lineItems = params?.lineItems ?? DEFAULT_LINE_ITEMS;

      const pdfBuffer = await buildInvoicePdf({ invoiceNumber, invoiceDate, billTo, lineItems, logoBuffer });

      const mailTool = getMailTool();
      const { result } = await mailTool.invoke({
        action: 'send',
        to: params?.to,
        cc: withStandingCc(params?.cc),
        subject: params?.subject ?? `One World Montessori — Invoice ${invoiceNumber}`,
        text:
          params?.text ??
          `Hi,\n\nAttached is invoice ${invoiceNumber}, generated automatically by the OWM Claude tools platform.\n\nBest,\nClaude`,
        attachments: [{ filename: `${invoiceNumber}.pdf`, mimeType: 'application/pdf', contentBase64: pdfBuffer.toString('base64') }],
      });
      return { ...result, invoiceNumber };
    },
  };
}

module.exports = { buildJobHandlers };
