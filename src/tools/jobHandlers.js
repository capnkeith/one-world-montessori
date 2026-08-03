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

// Regression (2026-08-02): the original default, `from:anthropic (invoice
// OR receipt)`, only ever matched a message actually sent BY Anthropic —
// but the real flow is Seth forwarding his own Anthropic receipt into this
// mailbox, so the message Gmail actually sees here is From Seth, not
// Anthropic. Searching by subject instead survives a forward, since
// forwarding preserves ("Fwd: ...") the original subject line.
const DEFAULT_SEARCH_QUERY = 'subject:(anthropic (invoice OR receipt))';

const DEFAULT_INTRO_TEXT = 'Hi Johanna,\n\nForwarding the latest invoice for your records.\n\nBest,\nClaude';

// The account this job's mail actions run as (see jobHandlers being wired
// with no `account` param — always the default/unnamed identity). Used to
// exclude this account's own sent mail from the invoice search below.
const SELF_ADDRESS = 'claude@oneworldmontessori.org';

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
  // Regression (2026-08-03): a test-mode send cc's claude@ on the test
  // copy so the human running the test can see it — but that cc lands
  // right back in claude@'s own inbox, which is exactly what this search
  // looks at. The next search then found that test copy instead of the
  // real one and re-forwarded it ("Fwd: Fwd: ..."), compounding a bit
  // further on every subsequent test. Tried `-from:me` first — verified
  // directly against real Gmail that it does NOT exclude these (a real
  // Gmail quirk, not a typo), so this excludes the literal address
  // instead, which does work. Excluding anything this account itself
  // sent closes the loop for good, regardless of which searchQuery is in
  // play — the legitimate source is always something a human forwarded
  // in, never something claude@ sent itself.
  async function findLatestInvoiceMessage(mailTool, searchQuery) {
    const { result } = await mailTool.invoke({ action: 'listMessages', query: `-from:${SELF_ADDRESS} ${searchQuery}`, maxResults: 1 });
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
   *
   * Test mode (`testTo` set, via scheduler's testJob) redirects the real
   * recipient/cc to a safe test address (default Seth, cc claude@) and
   * still actually sends — reading a JSON description of an email isn't
   * the same as receiving the real thing, and that's the point of a
   * test. Starts a fresh thread rather than reusing the real
   * recipient's thread, since that thread doesn't belong to the test
   * recipient. Plain `dryRun` with no `testTo` (not used by testJob
   * today, kept as a safe fallback for any future no-send caller) skips
   * sending entirely and returns a description instead.
   */
  async function forwardLatestInvoiceIfFound({ mailTool, params, job }) {
    const searchQuery = params?.searchQuery ?? DEFAULT_SEARCH_QUERY;
    const latest = await findLatestInvoiceMessage(mailTool, searchQuery);
    if (!latest) return null;

    const introText = params?.introText ?? DEFAULT_INTRO_TEXT;
    const isTest = Boolean(params?.testTo);

    if (isTest) {
      const { result } = await mailTool.invoke({
        action: 'forward',
        id: latest.id,
        to: params.testTo,
        cc: params?.testCc,
        introText,
      });
      return { ...result, forwardedMessageId: latest.id, testMode: true, realTo: params?.to, realCc: params?.cc };
    }

    const lastThreadId = [...job.history].reverse().find((h) => h.status === 'success' && h.detail?.threadId)?.detail
      ?.threadId;
    const to = params?.to;
    const cc = withStandingCc(params?.cc);

    if (params?.dryRun) {
      const { result: fetched } = await mailTool.invoke({ action: 'getMessage', id: latest.id });
      return {
        dryRun: true,
        wouldForward: true,
        to,
        cc,
        introText,
        threadId: lastThreadId ?? null,
        foundMessage: { id: latest.id, from: fetched.message.from, subject: fetched.message.subject },
      };
    }

    const { result } = await mailTool.invoke({ action: 'forward', id: latest.id, to, cc, introText, threadId: lastThreadId });
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

      if (params?.dryRun) {
        return {
          dryRun: true,
          wouldForward: false,
          wouldStartPestering: true,
          searchQuery: params?.searchQuery ?? DEFAULT_SEARCH_QUERY,
        };
      }

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
        if (params?.dryRun) return { ...forwarded, wouldStopPestering: true };
        const schedulerTool = getSchedulerTool();
        await schedulerTool.invoke({ action: 'cancelJob', id: job.id });
        return { ...forwarded, stoppedPestering: true };
      }

      if (params?.dryRun) {
        return { dryRun: true, wouldForward: false, wouldPester: true };
      }

      await mailTool.invoke({
        action: 'send',
        to: PESTER_RECIPIENTS.join(', '),
        subject: 'Missing invoice — needs attention',
        text: `Still haven't found a matching invoice email (search: "${params.searchQuery ?? DEFAULT_SEARCH_QUERY}"). Checking again tomorrow.`,
      });
      return { sent: false, reason: 'still missing — pestered' };
    },

    // Deliberately the simplest possible handler — no rendering tool, no
    // attachments at all — mainly useful for exercising the recurring
    // (interval) schedule type and the reply-driven stop flow end to end.
    'send-recurring-test-email': async (params) => {
      const mailTool = getMailTool();
      if (params?.dryRun) {
        return {
          dryRun: true,
          wouldSend: true,
          to: params?.to,
          subject: params?.subject ?? 'Recurring test email',
          text: params?.text ?? 'This is a recurring test email. Reply STOP to stop this.',
        };
      }
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
