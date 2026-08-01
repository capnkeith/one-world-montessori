'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDropboxTool } = require('../src/tools/dropbox');

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

const FIXTURE_ENTRIES = [
  { '.tag': 'folder', id: 'id:folder1', name: 'Photos', path_lower: '/photos' },
  { '.tag': 'file', id: 'id:file1', name: 'report.pdf', path_lower: '/report.pdf', size: 123, content_hash: 'abc' },
];

function fakeDropboxClient(entries) {
  return {
    call: async (endpoint, body) => {
      if (endpoint === 'files/list_folder') {
        return { entries: entries.filter((e) => (body.path || '') === '' || e.path_lower.startsWith(body.path)) };
      }
      if (endpoint === 'files/search_v2') {
        const needle = (body.query || '').toLowerCase();
        return {
          matches: entries
            .filter((e) => e.name.toLowerCase().includes(needle))
            .map((e) => ({ metadata: { metadata: e } })),
        };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
    download: async (path) => `content of ${path}`,
  };
}

test('setup stores the app key without requiring a real Dropbox app', async () => {
  const secretStore = fakeSecretStore();
  const tool = createDropboxTool({ secretStore, dropboxClientFactory: async () => fakeDropboxClient([]) });

  const { result } = await tool.invoke({ action: 'setup', appKey: 'fake-app-key' });
  assert.strictEqual(result.configured, true);
  assert.strictEqual(secretStore.get('dropbox_app_key'), 'fake-app-key');
});

test('browse lists entries and marks folders vs files correctly', async () => {
  const tool = createDropboxTool({
    secretStore: fakeSecretStore(),
    dropboxClientFactory: async () => fakeDropboxClient(FIXTURE_ENTRIES),
  });

  const { result } = await tool.invoke({ action: 'browse', folderId: 'root' });
  assert.strictEqual(result.entries.length, 2);
  assert.strictEqual(result.entries.find((e) => e.id === 'id:folder1').isFolder, true);
  assert.strictEqual(result.entries.find((e) => e.id === 'id:file1').isFolder, false);
  assert.strictEqual(result.entries.find((e) => e.id === 'id:file1').contentHash, 'abc');
});

test('search matches by name across the fake corpus', async () => {
  const tool = createDropboxTool({
    secretStore: fakeSecretStore(),
    dropboxClientFactory: async () => fakeDropboxClient(FIXTURE_ENTRIES),
  });

  const { result } = await tool.invoke({ action: 'search', query: 'report' });
  assert.strictEqual(result.results.length, 1);
  assert.strictEqual(result.results[0].id, 'id:file1');
});

test('getContent downloads file content by path', async () => {
  const tool = createDropboxTool({
    secretStore: fakeSecretStore(),
    dropboxClientFactory: async () => fakeDropboxClient(FIXTURE_ENTRIES),
  });

  const { result } = await tool.invoke({ action: 'getContent', path: '/report.pdf' });
  assert.strictEqual(result.content, 'content of /report.pdf');
});

test('realWorldTest skips gracefully when no folderId is supplied (never makes a real Dropbox call by accident)', async () => {
  const tool = createDropboxTool({
    secretStore: fakeSecretStore(),
    dropboxClientFactory: async () => fakeDropboxClient([]),
  });
  const outcome = await tool.runRealWorldTest({ label: 'generic-sweep' });
  assert.strictEqual(outcome.passed, true);
  assert.strictEqual(outcome.skipped, true);
});
