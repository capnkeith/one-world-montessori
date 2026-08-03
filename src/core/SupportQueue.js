'use strict';

const crypto = require('crypto');

const DEFAULT_LEASE_MS = 10 * 60_000; // 10 minutes

/**
 * The third job queue (see WORKER.md): unlike promptQueue (the sample
 * app's "Ask Claude" bar) or the reply-resolution queue (replies to a
 * scheduled job's own email), this one's "inbox" is real, unsolicited
 * incoming email to claude@ - anyone at the org can email in a request
 * tagged by subject line ("tech support" or "general") and a Claude
 * compute node answers it the same way, no separate submission channel
 * needed.
 *
 * Ticket shape: { id, messageId, threadId, category, from, subject,
 * body, receivedAt, resolvedAt, claimedBy, claimedAt, leaseExpiresAt }.
 * `messageId` is the real Gmail message id - registerIfNew is keyed on
 * it so the same email is never turned into two tickets even if a
 * node's Gmail search re-surfaces it before it's marked read.
 *
 * Same claim/lease shape as PromptQueue/Scheduler - see either for the
 * failover reasoning (a node that claims a ticket and disappears before
 * resolving it releases it automatically once the lease expires).
 *
 * Uses the same generic `store` interface as JobStore/PromptQueue
 * ({ load(): T[], save(items), mutate(id, updaterFn) }).
 */
class SupportQueue {
  constructor({ store }) {
    this.store = store;
  }

  /** Idempotent: returns the new ticket, or null if this messageId is already known. */
  registerIfNew({ messageId, threadId, category, from, subject, body, now = new Date() }) {
    const tickets = this.store.load();
    if (tickets.some((t) => t.messageId === messageId)) return null;
    const ticket = {
      id: crypto.randomUUID(),
      messageId,
      threadId,
      category,
      from,
      subject,
      body,
      receivedAt: now.toISOString(),
      resolvedAt: null,
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
    };
    tickets.push(ticket);
    this.store.save(tickets);
    return ticket;
  }

  listTickets() {
    return this.store.load();
  }

  getTicket(id) {
    return this.store.load().find((t) => t.id === id) ?? null;
  }

  /** Same failover shape as PromptQueue.claimPrompt/Scheduler.claimReplyEntry. */
  claimTicket({ id, nodeId, now = new Date(), leaseMs = DEFAULT_LEASE_MS }) {
    const ticket = this.store.mutate(id, (t) => {
      if (t.resolvedAt) return false;
      const heldByOther = t.claimedBy && t.claimedBy !== nodeId && t.leaseExpiresAt && new Date(t.leaseExpiresAt) > now;
      if (heldByOther) return false;
      t.claimedBy = nodeId;
      t.claimedAt = now.toISOString();
      t.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      return true;
    });
    if (!ticket) {
      const existing = this.getTicket(id);
      if (!existing) throw new Error(`No ticket with id ${id}`);
      if (existing.resolvedAt) throw new Error(`Ticket ${id} is already resolved`);
      throw new Error(`Ticket ${id} is already claimed by ${existing.claimedBy ?? 'another node'}`);
    }
    return ticket;
  }

  /** Anyone can resolve it (no ownership check), matching recordAnswer/recordFeedback's shape. */
  resolveTicket({ id, replyText, now = new Date() }) {
    const ticket = this.store.mutate(id, (t) => {
      t.replyText = replyText;
      t.resolvedAt = now.toISOString();
      t.claimedBy = null;
      t.claimedAt = null;
      t.leaseExpiresAt = null;
      return true;
    });
    if (!ticket) throw new Error(`No ticket with id ${id}`);
    return ticket;
  }
}

module.exports = { SupportQueue };
