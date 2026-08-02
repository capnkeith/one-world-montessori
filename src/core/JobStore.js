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
}

module.exports = { JobStore };
