'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSecretStore } = require('../src/core/SecretStore');

function tempStoreDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'owm-secretstore-test-'));
}

test('createSecretStore round-trips a value through the real platform backend and never stores it in the clear', async () => {
  const storeDir = tempStoreDir();
  const store = createSecretStore(storeDir);

  store.set('unit_test_secret', 'super-secret-value');
  assert.strictEqual(store.has('unit_test_secret'), true);
  assert.strictEqual(store.get('unit_test_secret'), 'super-secret-value');

  // Whatever got written to disk must not contain the plaintext value.
  for (const file of fs.readdirSync(storeDir)) {
    const contents = fs.readFileSync(path.join(storeDir, file), 'utf8');
    assert.ok(!contents.includes('super-secret-value'), `${file} must not contain the secret in the clear`);
  }

  store.delete('unit_test_secret');
  assert.strictEqual(store.has('unit_test_secret'), false);
  assert.strictEqual(store.get('unit_test_secret'), null);
});

test('list() only ever returns key names, never values', async () => {
  const store = createSecretStore(tempStoreDir());
  store.set('a', 'value-a');
  store.set('b', 'value-b');
  const keys = store.list();
  assert.deepStrictEqual([...keys].sort(), ['a', 'b']);
});
