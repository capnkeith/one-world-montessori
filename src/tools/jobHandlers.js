'use strict';

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
 * `send-monthly-invoice-email` composes the `invoice` tool (numbering/
 * defaults/logo, which itself composes the generic `pdf` tool) and the
 * `mail` tool - this handler is just "build an invoice, then email it,"
 * not where any PDF/numbering logic lives.
 */
function buildJobHandlers({ getMailTool, getInvoiceTool }) {
  return {
    'send-monthly-invoice-email': async (params) => {
      const invoiceTool = getInvoiceTool();
      const { result: invoiceResult } = await invoiceTool.invoke({
        action: 'build',
        billTo: params?.billTo,
        lineItems: params?.lineItems,
      });

      const mailTool = getMailTool();
      const { result } = await mailTool.invoke({
        action: 'send',
        to: params?.to,
        cc: withStandingCc(params?.cc),
        subject: params?.subject ?? `One World Montessori — Invoice ${invoiceResult.invoiceNumber}`,
        text:
          params?.text ??
          `Hi,\n\nAttached is invoice ${invoiceResult.invoiceNumber}, generated automatically by the OWM Claude tools platform.\n\nBest,\nClaude`,
        attachments: [
          { filename: invoiceResult.filename, mimeType: invoiceResult.mimeType, contentBase64: invoiceResult.contentBase64 },
        ],
      });
      return { ...result, invoiceNumber: invoiceResult.invoiceNumber };
    },
  };
}

module.exports = { buildJobHandlers };
