'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getDropboxClient } = require('../src/core/dropboxAuth');

function fakeSecretStore(initial = {}) {
  const store = { ...initial };
  return {
    get: (key) => store[key] ?? null,
    set: (key, value) => {
      store[key] = value;
    },
    has: (key) => key in store,
  };
}

test('getDropboxClient throws a clear error when no app key is configured', async () => {
  await assert.rejects(() => getDropboxClient({ secretStore: fakeSecretStore() }), /No Dropbox app configured/);
});

test('getDropboxClient refuses to launch a real consent flow when there is no interactive terminal (regression: 2026-08-01 runaway-browser incident)', async () => {
  const originalIsTTY = process.stdout.isTTY;
  process.stdout.isTTY = false;
  try {
    const secretStore = fakeSecretStore({ dropbox_app_key: 'fake-app-key' }); // app key set, no refresh token
    await assert.rejects(() => getDropboxClient({ secretStore }), /no interactive terminal/);
  } finally {
    process.stdout.isTTY = originalIsTTY;
  }
});
