'use strict';

/**
 * Real job-type handlers for the `scheduler` tool, kept separate from the
 * scheduling mechanism itself (src/core/Scheduler.js, src/tools/scheduler.js)
 * so adding a new job type never touches scheduling logic.
 *
 * `send-monthly-invoice-email` now has a real send path (the `mail` tool,
 * Gmail API — 2026-08-01) but is still deliberately incomplete: the job's
 * `params` must carry the actual subject/body/attachment, which nobody
 * has supplied yet (Seth is crafting the real email content himself, and
 * the sending identity — his own account vs. a dedicated
 * claude@oneworldmontessori.org mailbox being set up for dispute
 * resolution — isn't decided). Running this job before those params
 * exist fails loudly with a clear explanation instead of silently
 * no-op'ing or fabricating invoice content.
 */
function buildJobHandlers({ getMailTool }) {
  return {
    'send-monthly-invoice-email': async (params) => {
      if (!params?.subject || !(params.text || params.html)) {
        throw new Error(
          'send-monthly-invoice-email has no real content configured yet — job.params needs at least ' +
            '{ subject, text|html } (plus optional attachments) before this can actually send. ' +
            'Ask Seth for the real invoice format before filling these in.'
        );
      }
      const mailTool = getMailTool();
      const { result } = await mailTool.invoke({
        action: 'send',
        to: params.to,
        subject: params.subject,
        text: params.text,
        html: params.html,
        attachments: params.attachments,
      });
      return result;
    },
  };
}

module.exports = { buildJobHandlers };
