'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createContext } = require('../src/context');

function tempStateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'owm-test-'));
}

test('doctor reports version info and credential presence without leaking values', async () => {
  const { toolSet, secretStore } = createContext({ stateRoot: tempStateRoot() });
  secretStore.set('google_oauth_refresh_token', 'super-secret-value');

  const { result } = await toolSet.invoke('doctor', {});
  assert.strictEqual(result.credentials.googleOAuthPresent, true);
  assert.ok(!JSON.stringify(result).includes('super-secret-value'));
});

test('echo demonstrates nested version lineage through doctor', async () => {
  const { toolSet } = createContext({ stateRoot: tempStateRoot() });
  const { result, versionLineage } = await toolSet.invoke('echo', { message: 'hi' });

  assert.strictEqual(result.echoed, 'hi');
  assert.deepStrictEqual(versionLineage, [{ tool: 'echo', version: '1.0.0' }]);
  assert.deepStrictEqual(result.nested.versionLineage, [
    { tool: 'echo', version: '1.0.0' },
    { tool: 'doctor', version: '1.1.0' },
  ]);
});

test('every registered tool passes its internal test', async () => {
  const { toolSet } = createContext({ stateRoot: tempStateRoot() });
  const results = await toolSet.runAllTests();
  for (const [name, outcome] of Object.entries(results)) {
    assert.strictEqual(outcome.internal.passed, true, `${name} internal test failed: ${outcome.internal.error}`);
  }
});

test('every registered tool passes its real-world test against a named fixture', async () => {
  const { toolSet } = createContext({ stateRoot: tempStateRoot() });
  const testConfig = { label: 'ci-fixture', message: 'from-fixture' };
  const results = await toolSet.runAllTests({ realWorld: true, testConfig });
  for (const [name, outcome] of Object.entries(results)) {
    assert.strictEqual(outcome.real.passed, true, `${name} real-world test failed: ${outcome.real.error}`);
  }
});
