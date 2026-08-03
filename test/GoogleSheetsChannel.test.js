'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { GoogleSheetsChannel } = require('../src/core/GoogleSheetsChannel');

/** Minimal fake standing in for a real googleapis sheets v4 client's spreadsheets.values surface. */
function fakeSheetsClient(initialPresenceRows = []) {
  const presenceRows = [...initialPresenceRows];
  const calls = { append: [], update: [] };
  return {
    presenceRows,
    calls,
    spreadsheets: {
      values: {
        get: async ({ range }) => {
          if (range.startsWith('presence')) return { data: { values: presenceRows } };
          return { data: { values: [] } };
        },
        append: async ({ range, requestBody }) => {
          calls.append.push({ range, requestBody });
          presenceRows.push(...requestBody.values);
          return { data: { updates: { updatedRange: `${range.split('!')[0]}!A${presenceRows.length}:F${presenceRows.length}` } } };
        },
        update: async ({ range, requestBody }) => {
          calls.update.push({ range, requestBody });
          const rowNumber = Number(range.match(/!\w?(\d+)/)[1]) - 1;
          presenceRows[rowNumber] = requestBody.values[0];
        },
      },
    },
  };
}

test('announce appends a new peer row including toolSetVersion in column F', async () => {
  const sheetsClient = fakeSheetsClient();
  const channelBackend = new GoogleSheetsChannel({ spreadsheetId: 'sheet-1', sheetsClient });

  await channelBackend.announce({ instanceId: 'alice', displayName: 'Alice', photoLink: 'http://photo', tools: ['drive'], toolSetVersion: '3.2.1' });

  assert.strictEqual(sheetsClient.calls.append.length, 1);
  const [instanceId, displayName, , toolsJson, photoLink, toolSetVersion] = sheetsClient.calls.append[0].requestBody.values[0];
  assert.strictEqual(instanceId, 'alice');
  assert.strictEqual(displayName, 'Alice');
  assert.strictEqual(toolsJson, '["drive"]');
  assert.strictEqual(photoLink, 'http://photo');
  assert.strictEqual(toolSetVersion, '3.2.1');
});

test('list parses toolSetVersion back out of the presence rows', async () => {
  const nowIso = new Date().toISOString();
  const sheetsClient = fakeSheetsClient([['alice', 'Alice', nowIso, '["drive"]', 'http://photo', '3.2.1']]);
  const channelBackend = new GoogleSheetsChannel({ spreadsheetId: 'sheet-1', sheetsClient });

  const peers = await channelBackend.list();
  assert.strictEqual(peers.length, 1);
  assert.strictEqual(peers[0].toolSetVersion, '3.2.1');
});

test('re-announcing an existing peer updates their row (including toolSetVersion) rather than appending a duplicate', async () => {
  const nowIso = new Date().toISOString();
  const sheetsClient = fakeSheetsClient([['alice', 'Alice', nowIso, '[]', '', '1.0.0']]);
  const channelBackend = new GoogleSheetsChannel({ spreadsheetId: 'sheet-1', sheetsClient });

  await channelBackend.announce({ instanceId: 'alice', displayName: 'Alice', tools: ['drive'], toolSetVersion: '2.0.0' });

  assert.strictEqual(sheetsClient.calls.append.length, 0, 'must update the existing row, not append a second one');
  assert.strictEqual(sheetsClient.calls.update.length, 1);
  assert.match(sheetsClient.calls.update[0].range, /!A1:F1$/);

  const peers = await channelBackend.list();
  assert.strictEqual(peers.length, 1);
  assert.strictEqual(peers[0].toolSetVersion, '2.0.0');
});

test('an old row with no toolSetVersion column at all still lists cleanly, with toolSetVersion undefined', async () => {
  const nowIso = new Date().toISOString();
  const sheetsClient = fakeSheetsClient([['alice', 'Alice', nowIso, '[]', '']]);
  const channelBackend = new GoogleSheetsChannel({ spreadsheetId: 'sheet-1', sheetsClient });

  const peers = await channelBackend.list();
  assert.strictEqual(peers.length, 1);
  assert.strictEqual(peers[0].toolSetVersion, undefined);
});
