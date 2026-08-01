'use strict';

/**
 * In-memory file metadata index, built by replaying an append-only
 * stream of patch events (see CatalogEventLog.js). This is what makes
 * browsing/search "snappy" per the file-browser requirement — folder
 * listing and search never make a live network call, they run against
 * whatever's already loaded here. Only actually opening a file's real
 * content should ever need a live round-trip (to Drive, per the
 * opening user's own OAuth token — not built yet).
 *
 * A FileRecord's schema is deliberately open-ended: `enrichments` is a
 * free bucket for whatever automatic systems add over time (photo
 * recognition, alumni discovery, deep data mining, ...) without ever
 * needing a migration — each system just contributes patches keyed
 * under its own name in `enrichments`.
 *
 * Growth safety: this class only holds *current merged state* in
 * memory — snapshot()/fromSnapshot() persist that compact state, not
 * the raw patch history, and applyEvent() is idempotent by seq. A
 * canonical event log backend can therefore compact/archive old raw
 * events without this class caring, as long as the current state was
 * captured in a snapshot before truncation. That's the real answer to
 * "won't fill up" — bounded by number of *files*, not by 20 years of
 * accumulated patches.
 *
 * `origin` defaults to explicitly 'unknown' (not null/empty) — every
 * file has a provenance, we just may not have determined it yet. When
 * the Dropbox migration history is scanned, a patch updates it to the
 * real source. `tags` starts empty and is populated later by whatever
 * mining/enrichment runs — TAG_VOCABULARY is a starter/suggested set,
 * not an enum: new tags get added over time as they make sense, so
 * nothing here validates against it.
 */

// Starter vocabulary — expected to grow. Not enforced; just a reference
// list (e.g. for a UI's tag picker) so tagging stays reasonably consistent.
const TAG_VOCABULARY = [
  'staff', 'student', 'event', 'picture', 'video', 'official', 'document',
  'record', 'important', 'alumni', 'board', 'office', 'plan', 'guide',
  'book', 'publish', 'outreach', 'funding', 'private',
];

function createBlankRecord(id) {
  return {
    id,
    name: null,
    mimeType: null,
    isFolder: false,
    parentIds: [],
    locations: [], // [{ system, ref, addedAt, isPrimary }] — system: 'drive' | 'dropbox' | ...
    origin: { system: 'unknown', ref: null, note: null }, // updated once Dropbox (or other source) history is scanned
    tags: [], // freeform strings; see TAG_VOCABULARY for a starting/suggested set
    backup: { shouldBackup: false, reason: null },
    contentHash: null, // e.g. Drive md5Checksum, used for automatic duplicate detection
    size: null,
    contentText: null, // optional extracted text/description for search; filled in later by enrichment
    enrichments: {}, // { [systemName]: any } — open-ended, additive
    updatedAt: null,
  };
}

function unionByKey(items, keyFn) {
  const map = new Map();
  for (const item of items) map.set(keyFn(item), item);
  return [...map.values()];
}

/** Merges one patch into a record using additive semantics for array/object fields, last-write-wins for everything else. */
function mergeRecord(existing, patch, event) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'locations' && Array.isArray(value)) {
      merged.locations = unionByKey([...(existing.locations ?? []), ...value], (l) => `${l.system}:${l.ref}`);
    } else if (key === 'parentIds' && Array.isArray(value)) {
      merged.parentIds = [...new Set([...(existing.parentIds ?? []), ...value])];
    } else if (key === 'tags' && Array.isArray(value)) {
      merged.tags = [...new Set([...(existing.tags ?? []), ...value])];
    } else if (key === 'enrichments' && value && typeof value === 'object') {
      merged.enrichments = { ...(existing.enrichments ?? {}), ...value };
    } else {
      merged[key] = value;
    }
  }
  merged.updatedAt = event.patchedAt;
  return merged;
}

class FileCatalog {
  constructor() {
    this._records = new Map();
    this._lastSeq = 0;
  }

  get lastSeq() {
    return this._lastSeq;
  }

  /** Idempotent: replaying an already-applied event (by seq) is a no-op. */
  applyEvent(event) {
    if (event.seq <= this._lastSeq) return;
    const existing = this._records.get(event.targetId) ?? createBlankRecord(event.targetId);
    this._records.set(event.targetId, mergeRecord(existing, event.patch, event));
    this._lastSeq = event.seq;
  }

  getById(id) {
    return this._records.get(id) ?? null;
  }

  /** parentId: null/undefined means the root. */
  listFolder(parentId) {
    const target = parentId ?? null;
    return [...this._records.values()].filter((r) => (target === null ? r.parentIds.length === 0 : r.parentIds.includes(target)));
  }

  search(query) {
    const q = (query ?? '').trim().toLowerCase();
    if (!q) return [];
    return [...this._records.values()].filter((r) => {
      if (r.name?.toLowerCase().includes(q)) return true;
      if (r.contentText?.toLowerCase().includes(q)) return true;
      if (r.tags?.some((t) => t.toLowerCase().includes(q))) return true;
      return Object.values(r.enrichments ?? {}).some((v) => JSON.stringify(v).toLowerCase().includes(q));
    });
  }

  /** Duplicate locations sharing the same contentHash — the automatic dedup signal. */
  findDuplicatesOf(id) {
    const record = this.getById(id);
    if (!record?.contentHash) return [];
    return [...this._records.values()].filter((r) => r.id !== id && r.contentHash === record.contentHash);
  }

  snapshot() {
    return { lastSeq: this._lastSeq, records: [...this._records.values()] };
  }

  static fromSnapshot(snapshot) {
    const catalog = new FileCatalog();
    if (!snapshot) return catalog;
    catalog._lastSeq = snapshot.lastSeq ?? 0;
    for (const record of snapshot.records ?? []) {
      catalog._records.set(record.id, record);
    }
    return catalog;
  }
}

module.exports = { FileCatalog, createBlankRecord, TAG_VOCABULARY };
