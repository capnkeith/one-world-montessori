'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createClaudeTool } = require('../src/tools/claude');
const { createDriveTool } = require('../src/tools/drive');
const { createChannelTool } = require('../src/tools/channel');
const { InMemoryChannel } = require('../src/core/Channel');

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

function fakeProfile(initial = {}) {
  let state = { driveHiddenFolderIds: [], ...initial };
  return {
    load: () => state,
    update: (patch) => {
      state = { ...state, ...patch };
      return state;
    },
  };
}

function fakeDriveClient(files) {
  return {
    files: {
      list: async ({ q }) => {
        if (q.includes('name contains')) {
          const needle = q.match(/name contains '(.*?)'/)[1];
          return { data: { files: files.filter((f) => f.name.includes(needle)) } };
        }
        const parent = q.match(/'(.*?)' in parents/)[1];
        return { data: { files: files.filter((f) => f.parent === parent) } };
      },
    },
  };
}

const FIXTURE_FILES = [
  { id: 'folder-1', name: 'Photos', mimeType: 'application/vnd.google-apps.folder', parent: 'root' },
  { id: 'file-1', name: 'Report.docx', mimeType: 'application/vnd.google-apps.document', parent: 'root' },
];

// Stands in for the real Anthropic Tool Runner: no network call, just runs
// a fixed script of { name, input } tool calls against whatever tools the
// claude tool assembled, exactly as if Claude had "decided" to call them.
function scriptedToolRunner(script) {
  return (opts) =>
    (async () => {
      for (const { name, input } of script) {
        const tool = opts.tools.find((t) => t.name === name);
        await tool.run(input);
      }
    })();
}

test('setup stores the API key via SecretStore', async () => {
  const secretStore = fakeSecretStore();
  const tool = createClaudeTool({ secretStore, getDriveTool: () => null, getChannelTool: () => null });

  const { result } = await tool.invoke({ action: 'setup', apiKey: 'sk-ant-real-looking-key' });
  assert.strictEqual(result.configured, true);
  assert.ok(secretStore.has('anthropic_api_key'));
});

test('query throws a clear error when no API key is configured', async () => {
  const tool = createClaudeTool({ secretStore: fakeSecretStore(), getDriveTool: () => null, getChannelTool: () => null });

  await assert.rejects(() => tool.invoke({ action: 'query', query: 'anything' }), /Anthropic API key not configured/);
});

test('browse_drive proxies through ctx.call into the real drive tool, and a files answer comes back from claude.query', async () => {
  const driveTool = createDriveTool({
    secretStore: fakeSecretStore(),
    profile: fakeProfile(),
    driveClientFactory: async () => fakeDriveClient(FIXTURE_FILES),
  });
  const channelTool = createChannelTool({ channel: new InMemoryChannel(), instanceId: 'test', displayName: 'Test' });

  let rawBrowseResult = null;
  const tool = createClaudeTool({
    secretStore: fakeSecretStore({ anthropic_api_key: 'sk-ant-fake' }),
    getDriveTool: () => driveTool,
    getChannelTool: () => channelTool,
    anthropicClientFactory: () => ({
      beta: {
        messages: {
          toolRunner: (opts) =>
            (async () => {
              const browse = opts.tools.find((t) => t.name === 'browse_drive');
              rawBrowseResult = JSON.parse(await browse.run({ folderId: 'root' }));
              const respond = opts.tools.find((t) => t.name === 'respond_with_files');
              await respond.run({
                summary: 'Root folder contents',
                files: rawBrowseResult.entries.map((e) => ({ id: e.id, name: e.name, isFolder: e.isFolder })),
              });
            })(),
        },
      },
    }),
  });

  const { result } = await tool.invoke({ action: 'query', query: 'what is in my root folder?' });

  // Proves ctx.call actually reached the real drive tool with real fixture data.
  assert.strictEqual(rawBrowseResult.entries.length, 2);
  assert.ok(rawBrowseResult.entries.some((e) => e.id === 'folder-1' && e.isFolder));

  assert.strictEqual(result.type, 'files');
  assert.strictEqual(result.summary, 'Root folder contents');
  assert.strictEqual(result.files.find((f) => f.id === 'folder-1').isFolder, true);
});

test('search_drive proxies through ctx.call and real search results flow into a files answer', async () => {
  const driveTool = createDriveTool({
    secretStore: fakeSecretStore(),
    profile: fakeProfile(),
    driveClientFactory: async () => fakeDriveClient(FIXTURE_FILES),
  });
  const channelTool = createChannelTool({ channel: new InMemoryChannel(), instanceId: 'test', displayName: 'Test' });

  const tool = createClaudeTool({
    secretStore: fakeSecretStore({ anthropic_api_key: 'sk-ant-fake' }),
    getDriveTool: () => driveTool,
    getChannelTool: () => channelTool,
    anthropicClientFactory: () => ({
      beta: {
        messages: {
          toolRunner: (opts) =>
            (async () => {
              const search = opts.tools.find((t) => t.name === 'search_drive');
              const found = JSON.parse(await search.run({ query: 'Report' }));
              const respond = opts.tools.find((t) => t.name === 'respond_with_files');
              await respond.run({
                summary: 'Matches for "Report"',
                files: found.results.map((f) => ({ id: f.id, name: f.name, isFolder: f.isFolder })),
              });
            })(),
        },
      },
    }),
  });

  const { result } = await tool.invoke({ action: 'query', query: 'find files named Report' });
  assert.strictEqual(result.type, 'files');
  assert.strictEqual(result.files.length, 1);
  assert.strictEqual(result.files[0].name, 'Report.docx');
});

test('list_online_peers proxies through ctx.call into the real channel tool, and a text answer comes back', async () => {
  const sharedChannel = new InMemoryChannel();
  const peer = createChannelTool({ channel: sharedChannel, instanceId: 'peer-1', displayName: 'Peer One' });
  await peer.invoke({ action: 'announce' });

  const driveTool = createDriveTool({ secretStore: fakeSecretStore(), profile: fakeProfile(), driveClientFactory: async () => fakeDriveClient([]) });
  const channelTool = createChannelTool({ channel: sharedChannel, instanceId: 'test', displayName: 'Test' });

  const tool = createClaudeTool({
    secretStore: fakeSecretStore({ anthropic_api_key: 'sk-ant-fake' }),
    getDriveTool: () => driveTool,
    getChannelTool: () => channelTool,
    anthropicClientFactory: () => ({
      beta: {
        messages: {
          toolRunner: (opts) =>
            (async () => {
              const peers = opts.tools.find((t) => t.name === 'list_online_peers');
              const found = JSON.parse(await peers.run({}));
              const respond = opts.tools.find((t) => t.name === 'respond_with_text');
              await respond.run({ text: `${found.peers.length} peer(s) online: ${found.peers.map((p) => p.displayName).join(', ')}` });
            })(),
        },
      },
    }),
  });

  const { result } = await tool.invoke({ action: 'query', query: 'who is online?' });
  assert.strictEqual(result.type, 'text');
  assert.match(result.text, /Peer One/);
});

test('query falls back to a text answer if Claude never calls a respond_with_* tool', async () => {
  const tool = createClaudeTool({
    secretStore: fakeSecretStore({ anthropic_api_key: 'sk-ant-fake' }),
    getDriveTool: () => createDriveTool({ secretStore: fakeSecretStore(), profile: fakeProfile(), driveClientFactory: async () => fakeDriveClient([]) }),
    getChannelTool: () => createChannelTool({ channel: new InMemoryChannel(), instanceId: 'test', displayName: 'Test' }),
    anthropicClientFactory: () => ({ beta: { messages: { toolRunner: scriptedToolRunner([]) } } }),
  });

  const { result } = await tool.invoke({ action: 'query', query: 'anything' });
  assert.strictEqual(result.type, 'text');
  assert.match(result.text, /did not produce an answer/);
});

test('realWorldTest skips gracefully when no query is supplied (never makes a real Claude API call)', async () => {
  const tool = createClaudeTool({ secretStore: fakeSecretStore({ anthropic_api_key: 'sk-ant-fake' }), getDriveTool: () => null, getChannelTool: () => null });
  const outcome = await tool.runRealWorldTest({ label: 'generic-sweep' });
  assert.strictEqual(outcome.passed, true);
  assert.strictEqual(outcome.skipped, true);
});
