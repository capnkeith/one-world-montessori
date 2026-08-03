'use strict';

// Seth wants to be cc'd on all correspondence this system sends, not just
// this job's original recipients — merged in regardless of what's already
// in job.params.cc, deduped so re-running an already-updated job doesn't
// double him up.
const STANDING_CC = 'seth@oneworldmontessori.org';

// If a monthly search comes up empty, these get a daily reminder until
// the invoice actually shows up — not just Seth's OWM address, since he
// wants this to actually reach him wherever he'll see it promptly.
const PESTER_RECIPIENTS = ['seth@oneworldmontessori.org', 'seth.keith@citrix.com'];

function withStandingCc(cc) {
  const existing = cc ? (Array.isArray(cc) ? cc : [cc]) : [];
  return existing.includes(STANDING_CC) ? existing : [...existing, STANDING_CC];
}

/**
 * Real job-type handlers for the `scheduler` tool, kept separate from the
 * scheduling mechanism itself (src/core/Scheduler.js, src/tools/scheduler.js)
 * so adding a new job type never touches scheduling logic.
 */
function buildJobHandlers({ getMailTool, getSchedulerTool }) {
  async function findLatestInvoiceMessage(mailTool, searchQuery) {
    const { result } = await mailTool.invoke({ action: 'listMessages', query: searchQuery, maxResults: 1 });
    return result.messages[0] ?? null;
  }

  /**
   * Searches this account's own inbox (claude@ — Seth forwards his real
   * Anthropic invoice emails there each month, deliberately keeping this
   * job from ever needing to reach into someone else's mailbox) for the
   * latest matching message and forwards it as-is. Threads into the same
   * ongoing conversation with the recipient (the last successful run's
   * threadId) rather than starting a fresh thread every month. Returns
   * null (not an error) when nothing matches yet.
   */
  async function forwardLatestInvoiceIfFound({ mailTool, params, job }) {
    const searchQuery = params?.searchQuery ?? 'from:anthropic (invoice OR receipt)';
    const latest = await findLatestInvoiceMessage(mailTool, searchQuery);
    if (!latest) return null;

    const lastThreadId = [...job.history].reverse().find((h) => h.status === 'success' && h.detail?.threadId)?.detail
      ?.threadId;

    const { result } = await mailTool.invoke({
      action: 'forward',
      id: latest.id,
      to: params?.to,
      cc: withStandingCc(params?.cc),
      introText: params?.introText ?? 'Hi Johanna,\n\nForwarding the latest invoice for your records.\n\nBest,\nClaude',
      threadId: lastThreadId,
    });
    return { ...result, forwardedMessageId: latest.id };
  }

  return {
    /**
     * Finds the latest real invoice email (forwarded into this mailbox by
     * Seth each month) and relays it as-is to the business manager. If
     * nothing matches yet, starts (or reuses) a daily reminder job rather
     * than silently failing or waiting a full month to try again.
     */
    'send-monthly-invoice-email': async (params, job) => {
      const mailTool = getMailTool();
      const forwarded = await forwardLatestInvoiceIfFound({ mailTool, params, job });
      if (forwarded) return forwarded;

      const schedulerTool = getSchedulerTool();
      const { result: listed } = await schedulerTool.invoke({ action: 'listJobs' });
      let pesterJob = listed.jobs.find(
        (j) => j.type === 'pester-for-missing-invoice' && j.status === 'scheduled' && j.params?.parentJobId === job.id
      );
      if (!pesterJob) {
        const { result: created } = await schedulerTool.invoke({
          action: 'addJob',
          type: 'pester-for-missing-invoice',
          label: `Daily reminder: missing invoice for "${job.label}"`,
          schedule: { type: 'interval', minutes: 24 * 60 },
          retryPolicy: 'idempotent',
          params: {
            parentJobId: job.id,
            searchQuery: params?.searchQuery,
            to: params?.to,
            cc: params?.cc,
            introText: params?.introText,
          },
        });
        pesterJob = created;
      }
      // Fire the first reminder today instead of waiting a full day for
      // the interval schedule's first natural tick.
      await schedulerTool.invoke({ action: 'runJob', id: pesterJob.id });
      return { sent: false, reason: 'invoice not found yet — started daily reminders until it arrives' };
    },

    /**
     * Tries the same search+forward every day; the moment the invoice
     * shows up it forwards it (finishing the original job late rather
     * than making a human do it after being pestered) and cancels
     * itself. Until then, emails the pester list daily.
     */
    'pester-for-missing-invoice': async (params, job) => {
      const mailTool = getMailTool();
      const forwarded = await forwardLatestInvoiceIfFound({ mailTool, params, job });
      if (forwarded) {
        const schedulerTool = getSchedulerTool();
        await schedulerTool.invoke({ action: 'cancelJob', id: job.id });
        return { ...forwarded, stoppedPestering: true };
      }

      await mailTool.invoke({
        action: 'send',
        to: PESTER_RECIPIENTS.join(', '),
        subject: 'Missing invoice — needs attention',
        text: `Still haven't found a matching invoice email (search: "${params.searchQuery ?? 'from:anthropic (invoice OR receipt)'}"). Checking again tomorrow.`,
      });
      return { sent: false, reason: 'still missing — pestered' };
    },

    // Deliberately the simplest possible handler — no rendering tool, no
    // attachments at all — mainly useful for exercising the recurring
    // (interval) schedule type and the reply-driven stop flow end to end.
    'send-recurring-test-email': async (params) => {
      const mailTool = getMailTool();
      const { result } = await mailTool.invoke({
        action: 'send',
        to: params?.to,
        subject: params?.subject ?? 'Recurring test email',
        text: params?.text ?? 'This is a recurring test email. Reply STOP to stop this.',
      });
      return result;
    },
  };
}

module.exports = { buildJobHandlers };
