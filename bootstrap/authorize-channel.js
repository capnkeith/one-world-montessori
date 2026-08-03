'use strict';

// Run directly (not through src/cli.js) by first-run.ps1, in its own real
// interactive console session, right after a fresh install - the one
// point in a new machine's life where a real human is watching and a
// consent browser popup is expected, unlike the headless boot-launcher
// path this same auto-discovery also runs from on every subsequent boot
// (see src/server/http-server.js). Never fatal to setup: first-run.ps1
// doesn't check this script's exit code, since presence is a convenience,
// not core to OWM Drive working at all.

const path = require('path');
const { createSecretStore } = require('../src/core/SecretStore');
const { SECRETS_DIR } = require('../src/core/paths');
const { autoDiscoverChannel } = require('../src/core/autoDiscoverChannel');

async function main() {
  const secretStore = createSecretStore(SECRETS_DIR);
  await autoDiscoverChannel({ secretStore });
}

main().catch((err) => {
  console.log(`[channel] auto-discovery skipped (${err.message})`);
});
