'use strict';

const fs = require('fs');
const path = require('path');

/** Plain-JSON persistence for Scheduler's job list — jobs have no secrets in them, only schedules/params/history. */
class JobStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  load() {
    if (!fs.existsSync(this.filePath)) return [];
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
  }

  save(jobs) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(jobs, null, 2));
  }

  /**
   * Atomically applies `updaterFn` to the job with this id and persists
   * the result iff `updaterFn` returns true - this is the seam a real
   * distributed backend (e.g. Firestore) would wrap in an actual
   * transaction to make claim/complete race-safe across processes.
   * This local JSON implementation is NOT itself safe across concurrent
   * *processes* (a plain read-modify-write, same limitation
   * InvoiceCounter has today) - fine for one node, not yet fine for
   * genuinely distributed nodes sharing one file.
   */
  mutate(id, updaterFn) {
    const jobs = this.load();
    const job = jobs.find((j) => j.id === id);
    if (!job) return null;
    const shouldSave = updaterFn(job);
    if (!shouldSave) return null;
    this.save(jobs);
    return job;
  }
}

module.exports = { JobStore };
