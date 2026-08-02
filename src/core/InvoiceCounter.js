'use strict';

const fs = require('fs');
const path = require('path');

/**
 * A simple persistent sequence for invoice numbers — plain JSON, mirrors
 * Profile.js/JobStore.js. Formatted as OWM-INV-###### (6 digits,
 * zero-padded) so it reads as a real invoice number rather than a raw
 * integer.
 */
class InvoiceCounter {
  constructor(filePath) {
    this.filePath = filePath;
  }

  _load() {
    if (!fs.existsSync(this.filePath)) return { lastNumber: 0 };
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
  }

  _save(state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2));
  }

  /** Advances and returns the next invoice number (e.g. "OWM-INV-000001"). */
  next() {
    const state = this._load();
    state.lastNumber += 1;
    this._save(state);
    return `OWM-INV-${String(state.lastNumber).padStart(6, '0')}`;
  }

  peek() {
    return this._load().lastNumber;
  }
}

module.exports = { InvoiceCounter };
