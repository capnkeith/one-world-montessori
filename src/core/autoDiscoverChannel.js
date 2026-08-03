'use strict';

const { SharedSecretStore, createGoogleSecretManagerClient } = require('./SharedSecretStore');

/**
 * Tries once, at server startup, to fetch this node's channel credentials
 * from Secret Manager if they aren't already configured locally — makes
 * cross-machine presence "just work" for a new install without anyone
 * manually handing over the service-account key (see channel.js's own
 * `setup` action, still the manual fallback/override).
 *
 * Deliberately never throws or hangs the server: a brand new machine with
 * no cached cloud-platform credential yet, and no interactive terminal
 * available (this runs from the headless boot-launcher path), can't
 * complete that consent here — it just falls back to InMemoryChannel like
 * before, silently, until someone runs a CLI action once to authorize this
 * machine (the same "run it from a real terminal once" convention Drive/
 * Dropbox already use).
 */
async function autoDiscoverChannel({
  secretStore,
  sharedSecretStore = new SharedSecretStore({ secretStore, secretManagerClient: createGoogleSecretManagerClient({ secretStore }) }),
}) {
  if (secretStore.has('channel_service_account_key') && secretStore.has('channel_spreadsheet_id')) {
    return; // already configured, locally or from a prior successful auto-discovery
  }

  try {
    const keyJson = await sharedSecretStore.getShared('channel_service_account_key');
    const spreadsheetId = await sharedSecretStore.getShared('channel_spreadsheet_id');
    if (keyJson && spreadsheetId) {
      console.log('[channel] auto-discovered shared credentials from Secret Manager.');
    }
  } catch (err) {
    console.log(`[channel] auto-discovery skipped (${err.message}) — falling back to local-only presence until authorized.`);
  }
}

module.exports = { autoDiscoverChannel };
