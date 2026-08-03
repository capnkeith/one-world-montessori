'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getSecretManagerAuth, fetchSecret } = require('../src/core/googleSecretManager');

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

test('getSecretManagerAuth reuses a cached refresh token without any consent flow', async () => {
  const secretStore = fakeSecretStore({ google_secrets_refresh_token: 'fake-refresh-token' });
  const auth = await getSecretManagerAuth({ secretStore });
  assert.ok(auth);
});

test('getSecretManagerAuth refuses to launch a real consent flow when there is no interactive terminal (regression: 2026-08-01 runaway-browser incident)', async () => {
  const originalIsTTY = process.stdout.isTTY;
  process.stdout.isTTY = false;
  try {
    const secretStore = fakeSecretStore(); // no cached refresh token at all
    await assert.rejects(() => getSecretManagerAuth({ secretStore, allowConsent: true }), /a real interactive terminal/);
  } finally {
    process.stdout.isTTY = originalIsTTY;
  }
});

test('fetchSecret treats an unauthorized node as "nothing shared" instead of throwing (regression: 2026-08-02 out-of-place-consent-prompt incident — a plain read must never try to open a consent browser)', async () => {
  const secretStore = fakeSecretStore(); // never authorized cloud-platform access
  const value = await fetchSecret({ secretStore, name: 'dropbox_refresh_token' });
  assert.strictEqual(value, null);
});
