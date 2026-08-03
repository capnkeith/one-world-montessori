'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_PATH = path.join(os.tmpdir(), 'owm-local-channel.json');

/**
 * Shared-file backend for the Channel interface (src/core/Channel.js) —
 * lets separate local processes on ONE machine discover each other for
 * real, without provisioning Google Sheets (GoogleSheetsChannel.js) just
 * to exercise real cross-process peer presence/messaging. Same
 * announce/list/send/receive semantics as InMemoryChannel, just persisted
 * to one shared JSON file instead of private in-process memory.
 *
 * Not a production multi-machine backend: naive read-whole-file/
 * write-whole-file, fine for a handful of local dev processes polling
 * every several seconds, not built for high write concurrency or use
 * across real separate machines — that's what GoogleSheetsChannel is for.
 */
class FileChannel {
  constructor({ filePath = DEFAULT_PATH, staleAfterMs = 2 * 60 * 1000, messageTtlMs = 10 * 60 * 1000 } = {}) {
    this.filePath = filePath;
    this.staleAfterMs = staleAfterMs;
    this.messageTtlMs = messageTtlMs;
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return { peers: {}, messages: [], seq: 0 };
    }
  }

  _write(state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(state));
  }

  async announce({ instanceId, displayName, photoLink, tools = [], toolSetVersion }) {
    const state = this._read();
    state.peers[instanceId] = { instanceId, displayName, photoLink, tools, toolSetVersion, lastSeenMs: Date.now() };
    this._write(state);
  }

  async list() {
    const state = this._read();
    const now = Date.now();
    return Object.values(state.peers)
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
    const state = this._read();
    state.seq += 1;
    const message = { id: crypto.randomUUID(), seq: state.seq, from, to, type, payload, sentAtMs: Date.now() };
    state.messages.push(message);
    const cutoff = Date.now() - this.messageTtlMs;
    state.messages = state.messages.filter((m) => m.sentAtMs >= cutoff);
    this._write(state);
    return { id: message.id, seq: message.seq };
  }

  /** Messages addressed to instanceId or 'broadcast', with seq > sinceSeq. Never returns the caller's own sends. */
  async receive({ instanceId, sinceSeq = 0 }) {
    const state = this._read();
    return state.messages
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
}

module.exports = { FileChannel, DEFAULT_PATH };
