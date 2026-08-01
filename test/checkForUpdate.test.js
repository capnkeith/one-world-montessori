'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { checkForUpdate } = require('../bootstrap/check-for-update');

function fakeLogger() {
  const lines = [];
  return { log: (msg) => lines.push(msg), lines };
}

test('checkForUpdate: does nothing when installed commit already matches remote', () => {
  const { log, lines } = fakeLogger();
  let installCalled = false;
  const result = checkForUpdate({
    readInstalledCommit: () => 'abc123',
    fetchRemoteCommit: () => 'abc123',
    runInstall: () => {
      installCalled = true;
      return true;
    },
    log,
  });
  assert.strictEqual(result.updated, false);
  assert.strictEqual(result.reason, 'up-to-date');
  assert.strictEqual(installCalled, false);
  assert.ok(lines.some((l) => l.includes('already up to date')));
});

test('checkForUpdate: installs when remote has moved on, and reports success', () => {
  const { log } = fakeLogger();
  let installCalled = false;
  const result = checkForUpdate({
    readInstalledCommit: () => 'old-commit',
    fetchRemoteCommit: () => 'new-commit',
    runInstall: () => {
      installCalled = true;
      return true;
    },
    log,
  });
  assert.strictEqual(installCalled, true);
  assert.strictEqual(result.updated, true);
  assert.strictEqual(result.reason, 'installed');
  assert.strictEqual(result.commit, 'new-commit');
});

test('checkForUpdate: a failed install leaves the previous install in place and reports failure', () => {
  const { log } = fakeLogger();
  const result = checkForUpdate({
    readInstalledCommit: () => 'old-commit',
    fetchRemoteCommit: () => 'new-commit',
    runInstall: () => false,
    log,
  });
  assert.strictEqual(result.updated, false);
  assert.strictEqual(result.reason, 'install-failed');
});

test('checkForUpdate: treats no recorded commit (pre-existing install) as needing an update', () => {
  let installCalled = false;
  const result = checkForUpdate({
    readInstalledCommit: () => null,
    fetchRemoteCommit: () => 'new-commit',
    runInstall: () => {
      installCalled = true;
      return true;
    },
    log: () => {},
  });
  assert.strictEqual(installCalled, true);
  assert.strictEqual(result.updated, true);
});

test('checkForUpdate: an unreachable remote is skipped gracefully, never touches install', () => {
  const { log } = fakeLogger();
  let installCalled = false;
  const result = checkForUpdate({
    readInstalledCommit: () => 'old-commit',
    fetchRemoteCommit: () => {
      throw new Error('network unreachable');
    },
    runInstall: () => {
      installCalled = true;
      return true;
    },
    log,
  });
  assert.strictEqual(installCalled, false);
  assert.strictEqual(result.updated, false);
  assert.strictEqual(result.reason, 'unreachable');
});
