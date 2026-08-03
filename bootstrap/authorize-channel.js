'use strict';

// Run directly (not through src/cli.js) by first-run.ps1, in its own real
// interactive console session, right after a fresh install - the one
// point in a new machine's life where a real human is watching and a
// consent browser popup is expected, unlike the headless boot-launcher
// path this same auto-discovery also runs from on every subsequent boot
// (see src/server/http-server.js). Never fatal to setup: first-run.ps1
// doesn't check this script's exit code, since presence is a convenience,
// not core to OWM Drive working at all.
//
// This script's only reason to exist is being run directly by a human -
// unlike first-run.ps1 (a real console app, isTTY reliably true) or
// Claude Code's `!` passthrough (piped, but cli.js explicitly flags it
// allowed), some real terminal environments don't report stdout.isTTY
// truthfully even for a genuinely human-watched session (regression:
// found live 2026-08-03 - a real user ran this directly and the auto-
// discovery silently no-opped instead of opening a consent browser).
// Since being human-run is this file's entire premise, force-allow
// interactive consent here the same way src/cli.js already does for
// itself, rather than trusting TTY detection.
process.env.OWM_ALLOW_INTERACTIVE_CONSENT = '1';

const path = require('path');
const { createSecretStore } = require('../src/core/SecretStore');
const { SECRETS_DIR } = require('../src/core/paths');
const { autoDiscoverChannel } = require('../src/core/autoDiscoverChannel');
const { getCloudPlatformAuth } = require('../src/core/googleCloudAuth');

async function main() {
  console.log('[channel] checking shared presence access...');
  const secretStore = createSecretStore(SECRETS_DIR);

  // autoDiscoverChannel only ever reads (see its own header) - it never
  // requests consent, on purpose, so a headless boot can't pop a browser.
  // This script's entire premise is the opposite: a real human is watching
  // right now and a consent popup is expected. Without this call, a brand
  // new machine has no google_secrets_refresh_token and no supported way
  // to ever get one, so every later read silently resolves to "nothing
  // shared" forever (found live 2026-08-03 diagnosing a real user stuck at
  // onlinePeerCount: 0 with no error ever surfacing).
  if (!secretStore.has('google_secrets_refresh_token')) {
    try {
      await getCloudPlatformAuth({ secretStore, allowConsent: true });
    } catch (err) {
      console.log(`[channel] cloud-platform authorization skipped (${err.message})`);
    }
  }

  await autoDiscoverChannel({ secretStore });
  console.log('[channel] done.');
}

main().catch((err) => {
  console.log(`[channel] auto-discovery skipped (${err.message})`);
});
