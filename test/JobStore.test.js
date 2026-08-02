'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JobStore } = require('../src/core/JobStore');

function tmpStorePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'owm-jobstore-test-')), 'jobs.json');
}

test('load returns an empty array when no file exists yet', () => {
  const store = new JobStore(tmpStorePath());
  assert.deepStrictEqual(store.load(), []);
});

test('save then load round-trips the job list', () => {
  const store = new JobStore(tmpStorePath());
  store.save([{ id: 'a', status: 'scheduled' }]);
  assert.deepStrictEqual(store.load(), [{ id: 'a', status: 'scheduled' }]);
});

test('mutate applies the updater and persists when it returns true', () => {
  const store = new JobStore(tmpStorePath());
  store.save([{ id: 'a', status: 'scheduled' }]);

  const result = store.mutate('a', (job) => {
    job.status = 'claimed';
    return true;
  });

  assert.strictEqual(result.status, 'claimed');
  assert.strictEqual(store.load()[0].status, 'claimed', 'must actually be persisted');
});

test('mutate does not persist when the updater returns false (a lost race/veto)', () => {
  const store = new JobStore(tmpStorePath());
  store.save([{ id: 'a', status: 'claimed' }]);

  const result = store.mutate('a', (job) => {
    if (job.status !== 'scheduled') return false;
    job.status = 'claimed-again';
    return true;
  });

  assert.strictEqual(result, null);
  assert.strictEqual(store.load()[0].status, 'claimed', 'must be unchanged since the updater vetoed the mutation');
});

test('mutate returns null for an id that does not exist', () => {
  const store = new JobStore(tmpStorePath());
  store.save([{ id: 'a', status: 'scheduled' }]);
  const result = store.mutate('does-not-exist', () => true);
  assert.strictEqual(result, null);
});
