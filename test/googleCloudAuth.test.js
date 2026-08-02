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
    await assert.rejects(() => getCloudPlatformAuth({ secretStore }), /no interactive terminal/);
  } finally {
    process.stdout.isTTY = originalIsTTY;
  }
});
