'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getCloudPlatformAuth } = require('../src/core/googleCloudAuth');

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

test('getCloudPlatformAuth reuses a cached refresh token without any consent flow', async () => {
  const secretStore = fakeSecretStore({ google_secrets_refresh_token: 'fake-refresh-token' });
  const auth = await getCloudPlatformAuth({ secretStore });
  assert.ok(auth);
});

test('getCloudPlatformAuth refuses to launch a real consent flow when there is no interactive terminal', async () => {
  const originalIsTTY = process.stdout.isTTY;
  process.stdout.isTTY = false;
  try {
    const secretStore = fakeSecretStore();
    await assert.rejects(() => getCloudPlatformAuth({ secretStore, allowConsent: true }), /a real interactive terminal/);
  } finally {
    process.stdout.isTTY = originalIsTTY;
  }
});

test('getCloudPlatformAuth never attempts a consent flow without allowConsent, even with an interactive terminal (regression: 2026-08-02 out-of-place-consent-prompt incident)', async () => {
  const originalIsTTY = process.stdout.isTTY;
  process.stdout.isTTY = true;
  try {
    const secretStore = fakeSecretStore();
    const err = await getCloudPlatformAuth({ secretStore }).catch((e) => e);
    assert.ok(err instanceof Error);
    assert.strictEqual(err.code, 'GOOGLE_AUTH_REQUIRED');
  } finally {
    process.stdout.isTTY = originalIsTTY;
  }
});
