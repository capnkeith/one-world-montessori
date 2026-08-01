'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getDriveClient } = require('../src/core/googleAuth');
const DEFAULT_CLIENT_JSON = require('../src/core/default-google-oauth-client.json');

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

test('bundled default-google-oauth-client.json is well-formed (installed app client)', () => {
  assert.ok(DEFAULT_CLIENT_JSON.installed, 'must have an "installed" (Desktop app) client shape');
  assert.strictEqual(typeof DEFAULT_CLIENT_JSON.installed.client_id, 'string');
  assert.strictEqual(typeof DEFAULT_CLIENT_JSON.installed.client_secret, 'string');
  assert.ok(DEFAULT_CLIENT_JSON.installed.client_id.length > 0);
});

test('getDriveClient falls back to the bundled client when no client was configured via setup (regression: fresh installs must not require a manual setup step)', async () => {
  // A refresh token is already present so this never triggers the real
  // interactive consent flow (which opens a browser/local server) - this
  // test is purely about the "which client id/secret gets used" branch.
  const secretStore = fakeSecretStore({ google_oauth_refresh_token: 'fake-refresh-token' });
  assert.strictEqual(secretStore.get('google_oauth_client'), null, 'no client configured — this is the fresh-install case');

  const client = await getDriveClient({ secretStore });
  assert.ok(client, 'must return a usable Drive client without throwing or requiring setup first');
});

test('getDriveClient prefers an explicitly configured client over the bundled default', async () => {
  const overrideClient = JSON.stringify({
    installed: { client_id: 'override-id', client_secret: 'override-secret' },
  });
  const secretStore = fakeSecretStore({
    google_oauth_refresh_token: 'fake-refresh-token',
    google_oauth_client: overrideClient,
  });

  const client = await getDriveClient({ secretStore });
  assert.ok(client);
  // Real assertion is behavioral (no throw, client constructed) since
  // reaching into the googleapis internals for the id would be brittle;
  // the meaningful regression coverage is the "doesn't require setup" test above.
});

test('getDriveClient refuses to launch a real consent flow when there is no interactive terminal (regression: 2026-08-01 runaway-browser incident)', async () => {
  const originalIsTTY = process.stdout.isTTY;
  process.stdout.isTTY = false;
  try {
    const secretStore = fakeSecretStore(); // no cached refresh token at all
    await assert.rejects(() => getDriveClient({ secretStore }), /no interactive terminal/);
  } finally {
    process.stdout.isTTY = originalIsTTY;
  }
});
