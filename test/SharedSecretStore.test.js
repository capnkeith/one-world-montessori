'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SharedSecretStore } = require('../src/core/SharedSecretStore');

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

test('getShared returns the local value without ever touching the remote client', async () => {
  const secretStore = fakeSecretStore({ foo: 'local-value' });
  let remoteCalled = false;
  const shared = new SharedSecretStore({
    secretStore,
    secretManagerClient: { get: async () => { remoteCalled = true; return 'remote-value'; }, set: async () => {} },
  });

  const value = await shared.getShared('foo');
  assert.strictEqual(value, 'local-value');
  assert.strictEqual(remoteCalled, false);
});

test('getShared falls back to the remote client and caches the result locally', async () => {
  const secretStore = fakeSecretStore();
  let remoteCalls = 0;
  const shared = new SharedSecretStore({
    secretStore,
    secretManagerClient: {
      get: async () => {
        remoteCalls += 1;
        return 'remote-value';
      },
      set: async () => {},
    },
  });

  const first = await shared.getShared('foo');
  assert.strictEqual(first, 'remote-value');
  assert.strictEqual(secretStore.get('foo'), 'remote-value', 'must be cached locally after the first fetch');

  const second = await shared.getShared('foo');
  assert.strictEqual(second, 'remote-value');
  assert.strictEqual(remoteCalls, 1, 'second call must be served from the local cache, not the remote client again');
});

test('getShared returns null when nothing is found locally or remotely', async () => {
  const secretStore = fakeSecretStore();
  const shared = new SharedSecretStore({
    secretStore,
    secretManagerClient: { get: async () => null, set: async () => {} },
  });

  assert.strictEqual(await shared.getShared('missing'), null);
});

test('setShared writes both locally and to the remote client', async () => {
  const secretStore = fakeSecretStore();
  const remoteWrites = [];
  const shared = new SharedSecretStore({
    secretStore,
    secretManagerClient: { get: async () => null, set: async (name, value) => remoteWrites.push([name, value]) },
  });

  await shared.setShared('foo', 'bar');
  assert.strictEqual(secretStore.get('foo'), 'bar');
  assert.deepStrictEqual(remoteWrites, [['foo', 'bar']]);
});
