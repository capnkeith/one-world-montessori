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
    await assert.rejects(() => getDropboxClient({ secretStore, allowConsent: true }), /a real interactive terminal/);
  } finally {
    process.stdout.isTTY = originalIsTTY;
  }
});

test('getDropboxClient never attempts a consent flow without allowConsent, even with an interactive terminal (regression: 2026-08-02 out-of-place-consent-prompt incident)', async () => {
  const originalIsTTY = process.stdout.isTTY;
  process.stdout.isTTY = true;
  try {
    const secretStore = fakeSecretStore({ dropbox_app_key: 'fake-app-key' });
    await assert.rejects(
      () => getDropboxClient({ secretStore }),
      /authorize it explicitly first/,
      'a missing token must never silently start a consent flow as a side effect of an ordinary call'
    );
  } finally {
    process.stdout.isTTY = originalIsTTY;
  }
});

test('getDropboxClient finds a refresh token published by another node via sharedSecretStore before falling back to consent', async () => {
  const secretStore = fakeSecretStore({ dropbox_app_key: 'fake-app-key' });
  let sharedLookups = 0;
  const sharedSecretStore = {
    getShared: async (name) => {
      sharedLookups += 1;
      return name === 'dropbox_refresh_token' ? 'shared-refresh-token' : null;
    },
  };

  const client = await getDropboxClient({ secretStore, sharedSecretStore });
  assert.ok(client, 'must return a usable client without falling back to the interactive consent flow');
  assert.strictEqual(sharedLookups, 1);
  // Caching the shared value into the local SecretStore is SharedSecretStore's
  // own job (covered in SharedSecretStore.test.js) — dropboxAuth just consumes
  // whatever getShared returns.
});

test('getDropboxClient still refuses to open a browser when sharedSecretStore has nothing and there is no interactive terminal', async () => {
  const originalIsTTY = process.stdout.isTTY;
  process.stdout.isTTY = false;
  try {
    const secretStore = fakeSecretStore({ dropbox_app_key: 'fake-app-key' });
    const sharedSecretStore = { getShared: async () => null };
    await assert.rejects(
      () => getDropboxClient({ secretStore, sharedSecretStore, allowConsent: true }),
      /a real interactive terminal/
    );
  } finally {
    process.stdout.isTTY = originalIsTTY;
  }
});
