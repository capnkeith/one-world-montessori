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
    // `job` (the full job record, not just its params) is the second arg
    // Scheduler.runJob passes every handler — used here only to read
    // job.attachments, the pre-staged files fixed on the job at creation
    // time (see Scheduler.addJob). Never read anything else off `job` that
    // could vary at run time (e.g. don't go fetch something new based on
    // job.type) — mail.js's own guardrail rejects anything not tagged
    // 'rendered' or 'job-defined', but the discipline starts here: this is
    // the only place that decides what an email attaches, and it may only
    // ever draw from the invoice tool's fresh output or job.attachments.
    'send-monthly-invoice-email': async (params, job) => {
      const invoiceTool = getInvoiceTool();
      const { result: invoiceResult } = await invoiceTool.invoke({
        action: 'build',
        billTo: params?.billTo,
        lineItems: params?.lineItems,
      });

      const jobDefinedAttachments = (job?.attachments ?? []).map((a) => ({ ...a, source: 'job-defined' }));

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
          {
            filename: invoiceResult.filename,
            mimeType: invoiceResult.mimeType,
            contentBase64: invoiceResult.contentBase64,
            source: 'rendered',
          },
          ...jobDefinedAttachments,
        ],
      });
      return { ...result, invoiceNumber: invoiceResult.invoiceNumber };
    },
  };
}

module.exports = { buildJobHandlers };
