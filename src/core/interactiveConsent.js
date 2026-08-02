'use strict';

/**
 * Whether it's safe to launch a real interactive OAuth consent flow
 * (open a browser, wait for a human) from this process. Added after the
 * 2026-08-01 incident where a crash-looping background supervisor
 * relaunched a server that silently popped a new browser window on every
 * attempt.
 *
 * `process.stdout.isTTY` alone isn't a reliable signal: Claude Code's `!`
 * passthrough (a human explicitly running a command themselves) pipes
 * stdout back rather than attaching a real TTY, so a genuinely attended,
 * human-initiated CLI call would otherwise be refused too. `src/cli.js`
 * is the one front end that only a human runs directly - never the
 * automated boot/supervisor/install pipeline - so it explicitly sets
 * OWM_ALLOW_INTERACTIVE_CONSENT for the life of that process. Nothing in
 * the server/supervisor/installer code path ever sets this.
 */
function isInteractiveConsentAllowed() {
  return Boolean(process.stdout.isTTY) || process.env.OWM_ALLOW_INTERACTIVE_CONSENT === '1';
}

module.exports = { isInteractiveConsentAllowed };
