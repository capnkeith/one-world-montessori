'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { InvoiceCounter } = require('../src/core/InvoiceCounter');

function tmpCounterPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'owm-invoice-counter-test-')), 'invoice-counter.json');
}

test('starts at 1 and formats as OWM-INV-000001 when no state file exists yet', () => {
  const counter = new InvoiceCounter(tmpCounterPath());
  assert.strictEqual(counter.next(), 'OWM-INV-000001');
});

test('increments on every call and persists across separate instances (same file)', () => {
  const filePath = tmpCounterPath();
  const first = new InvoiceCounter(filePath);
  assert.strictEqual(first.next(), 'OWM-INV-000001');
  assert.strictEqual(first.next(), 'OWM-INV-000002');

  const second = new InvoiceCounter(filePath);
  assert.strictEqual(second.next(), 'OWM-INV-000003', 'must continue from persisted state, not restart at 1');
});

test('peek reports the last issued number without advancing it', () => {
  const counter = new InvoiceCounter(tmpCounterPath());
  assert.strictEqual(counter.peek(), 0);
  counter.next();
  counter.next();
  assert.strictEqual(counter.peek(), 2);
  assert.strictEqual(counter.peek(), 2, 'peek must not itself advance the counter');
});
