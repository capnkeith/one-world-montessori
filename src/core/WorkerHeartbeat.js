'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Tracks when a Claude compute node last actually checked the prompt
 * queue for work (see PromptQueue.js, src/tools/promptQueue.js) - the
 * sample app's Ask Claude bar uses this to grey itself out when no node
 * has checked in recently, rather than silently accepting prompts that
 * might sit unanswered indefinitely. Plain JSON, mirrors
 * InvoiceCounter.js/Profile.js.
 */
class WorkerHeartbeat {
  constructor(filePath) {
    this.filePath = filePath;
  }

  _load() {
    if (!fs.existsSync(this.filePath)) return { lastCheckedAt: null };
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
  }

  _save(state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2));
  }

  /** Called whenever a compute node checks the prompt queue - proves a provider is alive right now. */
  recordCheckIn(now = new Date()) {
    this._save({ lastCheckedAt: now.toISOString() });
  }

  lastCheckedAt() {
    return this._load().lastCheckedAt;
  }

  isHealthy({ staleAfterMs = 5 * 60_000, now = new Date() } = {}) {
    const { lastCheckedAt } = this._load();
    if (!lastCheckedAt) return false;
    return now.getTime() - Date.parse(lastCheckedAt) <= staleAfterMs;
  }
}

module.exports = { WorkerHeartbeat };
