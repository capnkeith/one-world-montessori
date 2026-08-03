'use strict';

const crypto = require('crypto');

/**
 * General-purpose rendezvous + messaging channel: peers announce
 * presence, discover who else is online, and exchange arbitrary
 * JSON-serializable payloads (any kind of data within JSON's limits —
 * base64-encode binary blobs into a string field if needed).
 *
 * Delivery model: at-least-once via polling. Every message gets a
 * unique id and a monotonic `seq`. receive({instanceId, sinceSeq})
 * returns everything newer than the caller's last-seen seq addressed to
 * them or 'broadcast' (and never echoes the sender's own messages back
 * to itself) — a receiver just needs to remember the highest seq it has
 * already processed to avoid gaps or replays across restarts.
 *
 * InMemoryChannel is the default: correct within a single process, and
 * what tests use so `npm test` needs no real Google credentials. It is
 * NOT a real cross-machine rendezvous — swap in a shared backend (e.g.
 * GoogleSheetsChannel, src/core/GoogleSheetsChannel.js) for that. Every
 * backend implements the same four methods, so nothing above this layer
 * needs to change when the backend does.
 */
class InMemoryChannel {
  constructor({ staleAfterMs = 2 * 60 * 1000, messageTtlMs = 10 * 60 * 1000 } = {}) {
    this.staleAfterMs = staleAfterMs;
    this.messageTtlMs = messageTtlMs;
    this._peers = new Map();
    this._messages = [];
    this._seq = 0;
  }

  async announce({ instanceId, displayName, photoLink, tools = [], toolSetVersion }) {
    this._peers.set(instanceId, { instanceId, displayName, photoLink, tools, toolSetVersion, lastSeenMs: Date.now() });
  }

  async list() {
    const now = Date.now();
    return [...this._peers.values()]
      .filter((p) => now - p.lastSeenMs <= this.staleAfterMs)
      .map(({ instanceId, displayName, photoLink, tools, toolSetVersion, lastSeenMs }) => ({
        instanceId,
        displayName,
        photoLink,
        tools: tools ?? [],
        toolSetVersion,
        lastSeen: new Date(lastSeenMs).toISOString(),
      }));
  }

  /** to: a specific instanceId, or 'broadcast'. payload: any JSON-serializable value. */
  async send({ from, to, type = 'message', payload }) {
    this._seq += 1;
    const message = { id: crypto.randomUUID(), seq: this._seq, from, to, type, payload, sentAtMs: Date.now() };
    this._messages.push(message);
    this._prune();
    return { id: message.id, seq: message.seq };
  }

  /** Messages addressed to instanceId or 'broadcast', with seq > sinceSeq, oldest first. Never returns the caller's own sends. */
  async receive({ instanceId, sinceSeq = 0 }) {
    this._prune();
    return this._messages
      .filter((m) => m.seq > sinceSeq && (m.to === instanceId || m.to === 'broadcast') && m.from !== instanceId)
      .map(({ id, seq, from, to, type, payload, sentAtMs }) => ({
        id,
        seq,
        from,
        to,
        type,
        payload,
        sentAt: new Date(sentAtMs).toISOString(),
      }));
  }

  _prune() {
    const cutoff = Date.now() - this.messageTtlMs;
    this._messages = this._messages.filter((m) => m.sentAtMs >= cutoff);
  }
}

module.exports = { InMemoryChannel };
