'use strict';

/**
 * Real job-type handlers for the `scheduler` tool, kept separate from the
 * scheduling mechanism itself (src/core/Scheduler.js, src/tools/scheduler.js)
 * so adding a new job type never touches scheduling logic.
 *
 * `send-monthly-invoice-email` is registered (so its job can actually be
 * scheduled today) but deliberately NOT implemented — the real email
 * format, the "options that feed back on the task" mechanism, and how
 * email actually gets sent (Gmail API needs its own OAuth scope; no
 * mail-sending tool exists yet) are all still open questions for Seth.
 * Running this job before it's filled in fails loudly with a clear
 * explanation instead of silently no-op'ing or fabricating an email.
 */
function buildJobHandlers() {
  return {
    'send-monthly-invoice-email': async () => {
      throw new Error(
        'send-monthly-invoice-email has no real implementation yet — this job is scheduled but not runnable. ' +
          'Needs: the actual invoice format/content, what "options that feed back on the task" means concretely, ' +
          'and a real email-sending mechanism (no Gmail-send tool exists yet). Ask Seth for these before implementing.'
      );
    },
  };
}

module.exports = { buildJobHandlers };
