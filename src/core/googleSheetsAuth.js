'use strict';

const { google } = require('googleapis');
const { GoogleSheetsChannel } = require('./GoogleSheetsChannel');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

/**
 * Builds a real GoogleSheetsChannel from whatever this node's own
 * `channel setup` action stored, or returns null if it hasn't been run
 * here yet — callers fall back to InMemoryChannel in that case (see
 * context.js). Unlike Drive/Gmail, this is a real bearer credential (a
 * service account private key), never bundled in the repo the way the
 * Drive OAuth client is (that one is a safe-to-distribute "installed app"
 * identifier; this is not) — every node that should see others online
 * needs this same key + spreadsheetId given to it once, out of band.
 */
function buildChannelFromSecretStore({ secretStore }) {
  const keyJson = secretStore.get('channel_service_account_key');
  const spreadsheetId = secretStore.get('channel_spreadsheet_id');
  if (!keyJson || !spreadsheetId) return null;

  const credentials = JSON.parse(keyJson);
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: SCOPES,
  });
  const sheetsClient = google.sheets({ version: 'v4', auth });
  return new GoogleSheetsChannel({ spreadsheetId, sheetsClient });
}

module.exports = { buildChannelFromSecretStore };
