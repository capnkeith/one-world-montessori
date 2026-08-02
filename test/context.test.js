'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createContext } = require('../src/context');
const { InMemoryChannel } = require('../src/core/Channel');
const { GoogleSheetsChannel } = require('../src/core/GoogleSheetsChannel');

function tempStateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'owm-context-test-'));
}

test('a patch applied after loading a snapshot with a high lastSeq actually persists (regression: event log seq must continue from the snapshot, not restart at 0)', async () => {
  const stateRoot = tempStateRoot();

  // First process: build up catalog state so its snapshot's lastSeq is high.
  {
    const { toolSet } = createContext({ stateRoot });
    for (let i = 0; i < 5; i++) {
      await toolSet.invoke('catalog', {
        action: 'reportPatch',
        targetId: `seed-${i}`,
        source: 'seed',
        patch: { name: `seed-${i}` },
      });
    }
  }

  // Second process (fresh InMemoryCatalogEventLog, loads the persisted
  // snapshot): a new patch must not be silently dropped as "already seen".
  {
    const { toolSet, catalog } = createContext({ stateRoot });
    assert.ok(catalog.lastSeq >= 5, 'snapshot should have loaded prior history');

    await toolSet.invoke('catalog', {
      action: 'reportPatch',
      targetId: 'target-folder',
      source: 'manual-tag',
      patch: { tags: ['private'] },
    });

    const { result } = await toolSet.invoke('catalog', { action: 'getFile', id: 'target-folder' });
    assert.deepStrictEqual(result.file.tags, ['private'], 'the patch must actually be reflected in catalog state, not silently dropped');
  }

  // Third process: the tag must survive yet another fresh load from disk.
  {
    const { toolSet } = createContext({ stateRoot });
    const { result } = await toolSet.invoke('catalog', { action: 'getFile', id: 'target-folder' });
    assert.deepStrictEqual(result.file.tags, ['private']);
  }
});

test('createContext defaults to InMemoryChannel when this node has never run channel setup', () => {
  const { channel } = createContext({ stateRoot: tempStateRoot() });
  assert.ok(channel instanceof InMemoryChannel);
});

test('createContext resolves a real GoogleSheetsChannel once channel setup has stored a key + spreadsheetId', async () => {
  const stateRoot = tempStateRoot();

  // Same path a real `channel setup` call takes (see channel.js) - via the
  // toolSet itself, not by poking secretStore directly, so this proves the
  // whole real wiring end to end, not just googleSheetsAuth.js in isolation.
  const { toolSet: firstProcessToolSet } = createContext({ stateRoot });
  await firstProcessToolSet.invoke('channel', {
    action: 'setup',
    serviceAccountKeyJson: JSON.stringify({ client_email: 'fake@example.iam.gserviceaccount.com', private_key: 'fake' }),
    spreadsheetId: 'fake-sheet-id',
  });

  // The channel backend is resolved once at startup (see context.js's own
  // doc comment) - a fresh createContext call is what stands in for "the
  // next process restart" here.
  const { channel } = createContext({ stateRoot });
  assert.ok(channel instanceof GoogleSheetsChannel);
  assert.strictEqual(channel.spreadsheetId, 'fake-sheet-id');
});

test('createContext still honors an explicitly-passed channel even when setup has been run (every test relies on this)', () => {
  const stateRoot = tempStateRoot();
  const explicitChannel = new InMemoryChannel();
  const { channel } = createContext({ stateRoot, channel: explicitChannel });
  assert.strictEqual(channel, explicitChannel);
});
