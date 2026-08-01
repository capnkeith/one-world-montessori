'use strict';

const crypto = require('crypto');

/**
 * Append-only patch log interface backing FileCatalog: append() records
 * one additive metadata patch (from a crawler, an enrichment system,
 * a manual edit, whatever); streamSince(seq) returns everything newer,
 * for a receiver to replay via FileCatalog.applyEvent().
 *
 * InMemoryCatalogEventLog is the default — correct within one process,
 * and what tests use so `npm test` needs no real credentials. It is NOT
 * a real shared, durable log. The real backend is an explicitly
 * deferred decision (leaning Firestore over Sheets specifically
 * because this data grows for 20+ years and must never need manual
 * compaction to avoid "filling up") — whatever it ends up being, it
 * only needs to implement these same two methods.
 */
class InMemoryCatalogEventLog {
  // startSeq MUST be the catalog snapshot's lastSeq when one is loaded —
  // this log is recreated fresh every process launch, so without this its
  // counter restarts at 0 and every new append() gets a seq lower than
  // the snapshot's, which FileCatalog.applyEvent()'s idempotency check
  // (`event.seq <= this._lastSeq`) then silently drops as "already
  // applied." Found the hard way: a real reportPatch call returned
  // `recorded: true` while the tag never actually reached the catalog.
  constructor({ startSeq = 0 } = {}) {
    this._events = [];
    this._seq = startSeq;
  }

  async append({ targetId, source, patch }) {
    this._seq += 1;
    const event = {
      id: crypto.randomUUID(),
      seq: this._seq,
      targetId,
      source,
      patch,
      patchedAt: new Date().toISOString(),
    };
    this._events.push(event);
    return event;
  }

  async streamSince(sinceSeq = 0) {
    return this._events.filter((e) => e.seq > sinceSeq);
  }
}

module.exports = { InMemoryCatalogEventLog };
