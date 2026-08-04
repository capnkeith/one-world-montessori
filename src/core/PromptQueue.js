'use strict';

const crypto = require('crypto');
const EventEmitter = require('node:events');

const DEFAULT_LEASE_MS = 10 * 60_000; // 10 minutes

/**
 * The second job queue (see WORKER.md): the sample app's "Ask Claude" bar
 * submits a prompt here instead of calling claude.query directly (which
 * bills the Anthropic API per token) - a Claude compute node pulls
 * unanswered prompts, replies, and the app polls for the answer. Same
 * claim/lease shape as Scheduler's job claiming (claimJob/completeJob)
 * and disputeResolver's reply claiming (claimReplyEntry), so multiple
 * compute nodes can safely pull from the same queue without two of them
 * answering the same prompt.
 *
 * Prompt shape: { id, query, user, submittedAt, answeredAt, answer,
 * claimedBy, claimedAt, leaseExpiresAt }. `user` is whichever account
 * actually submitted the query (the resolved identity of the OWM
 * install/process that served the sample app to them) - carried along so
 * whichever compute node answers it can see whose query this is and
 * honor *their* Drive view (see WORKER.md: hidden folders and sharing
 * can differ per account even within the shared OWM tree, so a node
 * answering on someone else's behalf must not just substitute its own
 * view without saying so).
 *
 * `answer` is `{ text, entries? }` - `entries` is an optional array of
 * Drive-entry-shaped objects (same shape `drive`'s browse/search return:
 * id/name/mimeType/isFolder/webViewLink) for a Drive-centered query whose
 * answer is naturally a file or a list of files/folders, rendered as real
 * clickable Drive entries in the app rather than just described in
 * prose. A plain non-Drive question just omits entries.
 *
 * Uses the same generic `store` interface as JobStore ({ load(): T[],
 * save(items), mutate(id, updaterFn) }) - in fact a plain JobStore
 * instance pointed at its own file works directly, since neither this
 * class nor JobStore know anything job-specific about the objects they
 * persist.
 */
class PromptQueue {
  constructor({ store }) {
    this.store = store;
    // Lets waitForPending resolve the instant something's submitted,
    // instead of a caller having to re-poll on a timer. Uncapped listener
    // count: every concurrent long-poll waiter (one per compute node's
    // background watcher) registers its own one-shot listener here, and
    // that's an expected, unbounded-by-any-real-number amount of them.
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
  }

  submit({ query, user = null, now = new Date() }) {
    if (!query) throw new Error('submit requires query');
    const prompt = {
      id: crypto.randomUUID(),
      query,
      user,
      submittedAt: now.toISOString(),
      answeredAt: null,
      answer: null,
      progress: null,
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
    };
    const prompts = this.store.load();
    prompts.push(prompt);
    this.store.save(prompts);
    this.events.emit('submitted');
    return prompt;
  }

  getPrompt(id) {
    return this.store.load().find((p) => p.id === id) ?? null;
  }

  listPrompts() {
    return this.store.load();
  }

  pendingCount() {
    return this.listPrompts().filter((p) => !p.answeredAt).length;
  }

  /**
   * The actual "select-like" primitive behind the queue: resolves the
   * instant there's at least one unanswered prompt - either right away
   * (something was already sitting there before this was even called) or
   * as soon as `submit` fires next - or after timeoutMs with nothing,
   * whichever comes first. Never claims anything itself (see
   * claimPrompt/checkPending for that), so it's safe for a background
   * watcher that's purely waiting, not about to actually answer.
   *
   * This is what turns "wake up every few minutes and check, even when
   * there's nothing to do" (a real cost when that re-check is itself a
   * Claude Code turn) into "block for free in plain code, only spend an
   * AI turn once there's real work" - a compute node runs this in a
   * backgrounded loop (see WORKER.md) instead of re-invoking checkPending
   * on a timer.
   */
  waitForPending({ timeoutMs }) {
    if (this.pendingCount() > 0) {
      return Promise.resolve({ ready: true, pendingCount: this.pendingCount() });
    }
    return new Promise((resolve) => {
      const onSubmitted = () => {
        clearTimeout(timer);
        resolve({ ready: true, pendingCount: this.pendingCount() });
      };
      const timer = setTimeout(() => {
        this.events.off('submitted', onSubmitted);
        resolve({ ready: false, pendingCount: 0 });
      }, timeoutMs);
      this.events.once('submitted', onSubmitted);
    });
  }

  /**
   * Claims a specific prompt for `nodeId` - fails (throws) if someone
   * else holds a still-live lease on it. Succeeds if unclaimed, already
   * held by this same nodeId, or the existing claim's lease has expired
   * (the node that had it disappeared) - that's the failover path, same
   * as claimReplyEntry, no separate reclaim step needed.
   */
  claimPrompt({ id, nodeId, now = new Date(), leaseMs = DEFAULT_LEASE_MS }) {
    const prompt = this.store.mutate(id, (p) => {
      if (p.answeredAt) return false;
      const heldByOther = p.claimedBy && p.claimedBy !== nodeId && p.leaseExpiresAt && new Date(p.leaseExpiresAt) > now;
      if (heldByOther) return false;
      p.claimedBy = nodeId;
      p.claimedAt = now.toISOString();
      p.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      return true;
    });
    if (!prompt) {
      const existing = this.getPrompt(id);
      if (!existing) throw new Error(`No prompt with id ${id}`);
      if (existing.answeredAt) throw new Error(`Prompt ${id} is already answered`);
      throw new Error(`Prompt ${id} is already claimed by ${existing.claimedBy ?? 'another node'}`);
    }
    return prompt;
  }

  /**
   * Lets whichever node currently holds the claim post a short status
   * string while it works (e.g. "searching Drive folders...") - purely
   * cosmetic, so the app has something better than a frozen spinner to
   * show during a genuinely slow query. Ownership-checked (must be the
   * current claimant) so a stale/expired node can't overwrite what the
   * node that actually took over is reporting.
   */
  reportProgress({ id, nodeId, progress, now = new Date() }) {
    const prompt = this.store.mutate(id, (p) => {
      if (p.answeredAt) return false;
      if (p.claimedBy !== nodeId) return false;
      p.progress = progress;
      return true;
    });
    if (!prompt) {
      const existing = this.getPrompt(id);
      if (!existing) throw new Error(`No prompt with id ${id}`);
      if (existing.answeredAt) throw new Error(`Prompt ${id} is already answered`);
      throw new Error(`Prompt ${id} is claimed by ${existing.claimedBy ?? 'no one'}, not ${nodeId}`);
    }
    return prompt;
  }

  /** Records the answer and releases the claim - anyone can complete it (no ownership check), matching disputeResolver.recordFeedback's shape. */
  recordAnswer({ id, answer, now = new Date() }) {
    const prompt = this.store.mutate(id, (p) => {
      p.answer = answer;
      p.answeredAt = now.toISOString();
      p.claimedBy = null;
      p.claimedAt = null;
      p.leaseExpiresAt = null;
      return true;
    });
    if (!prompt) throw new Error(`No prompt with id ${id}`);
    return prompt;
  }
}

module.exports = { PromptQueue };
