'use strict';

const crypto = require('crypto');

const DEFAULT_LEASE_MS = 10 * 60_000; // 10 minutes

/**
 * The second job queue (see WORKER.md): the sample app's "Ask Claude" bar
 * submits a prompt here instead of calling claude.query directly (which
 * bills the Anthropic API per token) - a Claude compute node pulls
 * unanswered prompts, replies in plain text, and the app polls for the
 * answer. Same claim/lease shape as Scheduler's job claiming
 * (claimJob/completeJob) and disputeResolver's reply claiming
 * (claimReplyEntry), so multiple compute nodes can safely pull from the
 * same queue without two of them answering the same prompt.
 *
 * Prompt shape: { id, query, submittedAt, answeredAt, answer, claimedBy,
 * claimedAt, leaseExpiresAt }. Uses the same generic `store` interface as
 * JobStore ({ load(): T[], save(items), mutate(id, updaterFn) }) - in
 * fact a plain JobStore instance pointed at its own file works directly,
 * since neither this class nor JobStore know anything job-specific about
 * the objects they persist.
 */
class PromptQueue {
  constructor({ store }) {
    this.store = store;
  }

  submit({ query, now = new Date() }) {
    if (!query) throw new Error('submit requires query');
    const prompt = {
      id: crypto.randomUUID(),
      query,
      submittedAt: now.toISOString(),
      answeredAt: null,
      answer: null,
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
    };
    const prompts = this.store.load();
    prompts.push(prompt);
    this.store.save(prompts);
    return prompt;
  }

  getPrompt(id) {
    return this.store.load().find((p) => p.id === id) ?? null;
  }

  listPrompts() {
    return this.store.load();
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
