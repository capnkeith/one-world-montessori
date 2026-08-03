'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getGmailClient } = require('../src/core/gmailAuth');

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

test('the default (unnamed) account reuses gmail_refresh_token without any consent flow', async () => {
  const secretStore = fakeSecretStore({ gmail_refresh_token: 'fake-default-token' });
  const client = await getGmailClient({ secretStore });
  assert.ok(client);
});

test('a named account reuses its own gmail_refresh_token_<account> key, separate from the default', async () => {
  const secretStore = fakeSecretStore({
    gmail_refresh_token: 'fake-default-token',
    gmail_refresh_token_seth: 'fake-seth-token',
  });
  const client = await getGmailClient({ secretStore, account: 'seth' });
  assert.ok(client, 'must succeed using the seth-specific token, not require the default one');
});

test('authorizing a new named account never touches or requires the default account\'s token', async () => {
  const originalIsTTY = process.stdout.isTTY;
  process.stdout.isTTY = false;
  try {
    // No default token cached at all - only asking for the "seth" account,
    // which also has no cached token - must fail on ITS OWN missing
    // credentials, not silently fall back to (or demand) the default key.
    const secretStore = fakeSecretStore({ gmail_refresh_token: 'fake-default-token' });
    await assert.rejects(
      () => getGmailClient({ secretStore, account: 'seth' }),
      /no interactive terminal/,
      'must attempt its own consent flow for the missing seth-specific token, not reuse the default token'
    );
  } finally {
    process.stdout.isTTY = originalIsTTY;
  }
});

test('refuses to launch a real consent flow when there is no interactive terminal (regression: 2026-08-01 runaway-browser incident)', async () => {
  const originalIsTTY = process.stdout.isTTY;
  process.stdout.isTTY = false;
  try {
    const secretStore = fakeSecretStore();
    await assert.rejects(() => getGmailClient({ secretStore }), /no interactive terminal/);
  } finally {
    process.stdout.isTTY = originalIsTTY;
  }
});
