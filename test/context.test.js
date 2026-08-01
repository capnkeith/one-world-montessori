'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createContext } = require('../src/context');

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
