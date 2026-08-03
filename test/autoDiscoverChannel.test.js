'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { autoDiscoverChannel } = require('../src/core/autoDiscoverChannel');

function fakeSecretStore(initial = {}) {
  const store = { ...initial };
  return {
    get: (k) => store[k] ?? null,
    set: (k, v) => {
      store[k] = v;
    },
    has: (k) => store[k] != null,
  };
}

function fakeSharedSecretStore(remoteValues) {
  const calls = [];
  return {
    calls,
    getShared: async (name) => {
      calls.push(name);
      return remoteValues[name] ?? null;
    },
  };
}

test('does nothing (never touches Secret Manager) when this node already has both values locally', async () => {
  const secretStore = fakeSecretStore({ channel_service_account_key: 'local-key', channel_spreadsheet_id: 'local-id' });
  const sharedSecretStore = fakeSharedSecretStore({});

  await autoDiscoverChannel({ secretStore, sharedSecretStore });
  assert.deepStrictEqual(sharedSecretStore.calls, []);
});

test('fetches and reports success when Secret Manager has both values', async () => {
  const secretStore = fakeSecretStore();
  const sharedSecretStore = fakeSharedSecretStore({
    channel_service_account_key: 'remote-key',
    channel_spreadsheet_id: 'remote-id',
  });

  await autoDiscoverChannel({ secretStore, sharedSecretStore });
  assert.deepStrictEqual(sharedSecretStore.calls.sort(), ['channel_service_account_key', 'channel_spreadsheet_id']);
});

test('never throws even when Secret Manager access fails entirely (e.g. no cached credential, no interactive terminal)', async () => {
  const secretStore = fakeSecretStore();
  const sharedSecretStore = {
    getShared: async () => {
      throw new Error('No cached cloud-platform credentials, and this process has no interactive terminal');
    },
  };

  await assert.doesNotReject(() => autoDiscoverChannel({ secretStore, sharedSecretStore }));
});
