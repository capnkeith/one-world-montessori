'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { GoogleSheetsChannel } = require('../src/core/GoogleSheetsChannel');

/**
 * Minimal fake standing in for a real googleapis sheets v4 client's
 * spreadsheets.values surface. Tracks each named sheet's rows separately
 * (by the part of `range` before '!'), the same way the real spreadsheet
 * has a distinct `presence` tab and `messages` tab sharing one client.
 */
function fakeSheetsClient(initialRowsBySheet = {}) {
  const rowsBySheet = {};
  for (const [sheet, rows] of Object.entries(initialRowsBySheet)) rowsBySheet[sheet] = [...rows];
  const calls = { append: [], update: [] };
  const sheetNameOf = (range) => range.split('!')[0];
  const rowsFor = (range) => (rowsBySheet[sheetNameOf(range)] ??= []);

  return {
    rowsBySheet,
    calls,
    // Back-compat for the presence-only tests below, written before
    // messages coverage existed.
    get presenceRows() {
      return rowsFor('presence');
    },
    spreadsheets: {
      values: {
        get: async ({ range }) => ({ data: { values: [...rowsFor(range)] } }),
        append: async ({ range, requestBody }) => {
          calls.append.push({ range, requestBody });
          const rows = rowsFor(range);
          rows.push(...requestBody.values);
          const colSpan = String.fromCharCode('A'.charCodeAt(0) + requestBody.values[0].length - 1);
          return { data: { updates: { updatedRange: `${sheetNameOf(range)}!A${rows.length}:${colSpan}${rows.length}` } } };
        },
        update: async ({ range, requestBody }) => {
          calls.update.push({ range, requestBody });
          const rows = rowsFor(range);
          const rowNumber = Number(range.match(/!\w?(\d+)/)[1]) - 1;
          const startCol = range.match(/!([A-Z]+)\d/)[1].charCodeAt(0) - 'A'.charCodeAt(0);
          rows[rowNumber] ??= [];
          requestBody.values[0].forEach((value, i) => {
            rows[rowNumber][startCol + i] = value;
          });
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
  const sheetsClient = fakeSheetsClient({ presence: [['alice', 'Alice', nowIso, '["drive"]', 'http://photo', '3.2.1']] });
  const channelBackend = new GoogleSheetsChannel({ spreadsheetId: 'sheet-1', sheetsClient });

  const peers = await channelBackend.list();
  assert.strictEqual(peers.length, 1);
  assert.strictEqual(peers[0].toolSetVersion, '3.2.1');
});

test('re-announcing an existing peer updates their row (including toolSetVersion) rather than appending a duplicate', async () => {
  const nowIso = new Date().toISOString();
  const sheetsClient = fakeSheetsClient({ presence: [['alice', 'Alice', nowIso, '[]', '', '1.0.0']] });
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
  const sheetsClient = fakeSheetsClient({ presence: [['alice', 'Alice', nowIso, '[]', '']] });
  const channelBackend = new GoogleSheetsChannel({ spreadsheetId: 'sheet-1', sheetsClient });

  const peers = await channelBackend.list();
  assert.strictEqual(peers.length, 1);
  assert.strictEqual(peers[0].toolSetVersion, undefined);
});

// The actual chat feature (src/tools/chat.js -> src/tools/channel.js) runs
// entirely over send/receive - unlike announce/list above, these had zero
// coverage against anything resembling the real Sheets backend before this
// (regression investigation, 2026-08-04: real, reported chat bugs -
// "messages never seemed to get sent", "dialog seemed to get stuck" -
// traced to this exact path being untested in front of real production
// use).

test('send backfills seq from the row the append actually landed on', async () => {
  const sheetsClient = fakeSheetsClient();
  const channelBackend = new GoogleSheetsChannel({ spreadsheetId: 'sheet-1', sheetsClient });

  const receipt = await channelBackend.send({ from: 'alice', to: 'bob', type: 'chat-message', payload: { text: 'hi' } });
  assert.strictEqual(receipt.seq, 1);
  assert.ok(receipt.id);

  const row = sheetsClient.rowsBySheet.messages[0];
  assert.strictEqual(row[0], 1, 'the backfill update must actually land in the sheet, not just the returned receipt');
  assert.strictEqual(row[2], 'alice');
  assert.strictEqual(row[3], 'bob');
  assert.deepStrictEqual(JSON.parse(row[5]), { text: 'hi' });
});

test('send assigns strictly increasing seq across multiple messages', async () => {
  const sheetsClient = fakeSheetsClient();
  const channelBackend = new GoogleSheetsChannel({ spreadsheetId: 'sheet-1', sheetsClient });

  const first = await channelBackend.send({ from: 'alice', to: 'bob', type: 'chat-message', payload: 'one' });
  const second = await channelBackend.send({ from: 'alice', to: 'bob', type: 'chat-message', payload: 'two' });
  assert.ok(second.seq > first.seq);
});

test('receive returns only messages newer than sinceSeq, addressed to instanceId or broadcast, never the caller\'s own sends', async () => {
  const sheetsClient = fakeSheetsClient();
  const channelBackend = new GoogleSheetsChannel({ spreadsheetId: 'sheet-1', sheetsClient });

  await channelBackend.send({ from: 'alice', to: 'bob', type: 'chat-message', payload: 'to bob' });
  await channelBackend.send({ from: 'alice', to: 'carol', type: 'chat-message', payload: 'to carol' });
  await channelBackend.send({ from: 'alice', to: 'broadcast', type: 'chat-message', payload: 'to everyone' });
  await channelBackend.send({ from: 'bob', to: 'alice', type: 'chat-message', payload: 'not for bob' });

  const bobMessages = await channelBackend.receive({ instanceId: 'bob' });
  assert.strictEqual(bobMessages.length, 2, 'bob should see his own direct message and the broadcast, nothing else');
  assert.deepStrictEqual(bobMessages.map((m) => m.payload).sort(), ['to bob', 'to everyone'].sort());

  const latestSeq = Math.max(...bobMessages.map((m) => m.seq));
  const nothingNew = await channelBackend.receive({ instanceId: 'bob', sinceSeq: latestSeq });
  assert.strictEqual(nothingNew.length, 0, 'sinceSeq must actually filter out already-seen messages');
});

test(
  'regression (2026-08-04 investigation): a receive() landing exactly between send()\'s append and its seq-backfill update misses that message, but sees it on the very next call',
  async () => {
    // send() is deliberately two API calls (see its own header comment) -
    // append the row, THEN backfill its real seq once the row's actual
    // position is known. A receive() that reads the sheet in that exact
    // window sees a row whose seq cell is still blank. This documents and
    // bounds that known race (self-heals next poll, sinceSeq unmoved) so a
    // future change can't silently make it worse without a test noticing.
    const sheetsClient = fakeSheetsClient();
    const channelBackend = new GoogleSheetsChannel({ spreadsheetId: 'sheet-1', sheetsClient });

    const realAppend = sheetsClient.spreadsheets.values.append;
    sheetsClient.spreadsheets.values.append = async (args) => {
      const res = await realAppend(args);
      // Simulate a receive() call landing exactly here, before the
      // caller's follow-up update() has run.
      const midWindow = await channelBackend.receive({ instanceId: 'bob' });
      assert.strictEqual(midWindow.length, 0, 'a message whose seq has not been backfilled yet must not appear as ready');
      return res;
    };

    await channelBackend.send({ from: 'alice', to: 'bob', type: 'chat-message', payload: 'hi bob' });

    const afterBackfill = await channelBackend.receive({ instanceId: 'bob' });
    assert.strictEqual(afterBackfill.length, 1, 'once the backfill update lands, the very next receive() must see it - nothing is permanently lost');
    assert.strictEqual(afterBackfill[0].payload, 'hi bob');
  }
);
