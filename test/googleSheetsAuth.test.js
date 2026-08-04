'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildChannelFromSecretStore } = require('../src/core/googleSheetsAuth');
const { GoogleSheetsChannel } = require('../src/core/GoogleSheetsChannel');

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

// This is the one function standing between "channel setup ran / secrets
// were auto-discovered" and the real cross-machine chat/presence backend
// actually being used - previously untested anywhere (confirmed: it's not
// exercised by autoDiscoverChannel.test.js, which only covers fetching the
// raw secret values, never turns them into a channel).

test('returns null (falls back to InMemoryChannel) when neither secret is present', () => {
  const channel = buildChannelFromSecretStore({ secretStore: fakeSecretStore() });
  assert.strictEqual(channel, null);
});

test('returns null when only the service account key is present, not the spreadsheetId', () => {
  const secretStore = fakeSecretStore({ channel_service_account_key: JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'x' }) });
  assert.strictEqual(buildChannelFromSecretStore({ secretStore }), null);
});

test('returns null when only the spreadsheetId is present, not the service account key', () => {
  const secretStore = fakeSecretStore({ channel_spreadsheet_id: 'sheet-123' });
  assert.strictEqual(buildChannelFromSecretStore({ secretStore }), null);
});

test('builds a real GoogleSheetsChannel pointed at the stored spreadsheetId once both secrets are present', () => {
  const secretStore = fakeSecretStore({
    channel_service_account_key: JSON.stringify({ client_email: 'bot@project.iam.gserviceaccount.com', private_key: 'fake-key' }),
    channel_spreadsheet_id: 'sheet-abc-123',
  });

  const channel = buildChannelFromSecretStore({ secretStore });
  assert.ok(channel instanceof GoogleSheetsChannel);
  assert.strictEqual(channel.spreadsheetId, 'sheet-abc-123');
});

test('a malformed (non-JSON) stored key throws clearly rather than silently falling back', () => {
  const secretStore = fakeSecretStore({
    channel_service_account_key: 'not valid json',
    channel_spreadsheet_id: 'sheet-abc-123',
  });

  assert.throws(() => buildChannelFromSecretStore({ secretStore }), SyntaxError);
});
