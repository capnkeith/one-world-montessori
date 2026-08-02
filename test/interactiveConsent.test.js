'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isInteractiveConsentAllowed } = require('../src/core/interactiveConsent');

function withEnvAndTTY(envValue, ttyValue, fn) {
  const originalEnv = process.env.OWM_ALLOW_INTERACTIVE_CONSENT;
  const originalTTY = process.stdout.isTTY;
  process.env.OWM_ALLOW_INTERACTIVE_CONSENT = envValue;
  process.stdout.isTTY = ttyValue;
  try {
    return fn();
  } finally {
    if (originalEnv === undefined) delete process.env.OWM_ALLOW_INTERACTIVE_CONSENT;
    else process.env.OWM_ALLOW_INTERACTIVE_CONSENT = originalEnv;
    process.stdout.isTTY = originalTTY;
  }
}

test('refuses when neither a real TTY nor the CLI env flag is present (background/service process)', () => {
  withEnvAndTTY(undefined, false, () => {
    assert.strictEqual(isInteractiveConsentAllowed(), false);
  });
});

test('allows when stdout is a real TTY, even without the env flag', () => {
  withEnvAndTTY(undefined, true, () => {
    assert.strictEqual(isInteractiveConsentAllowed(), true);
  });
});

test('allows when the CLI env flag is set, even without a real TTY (regression: Claude Code\'s "!" passthrough pipes stdout)', () => {
  withEnvAndTTY('1', false, () => {
    assert.strictEqual(isInteractiveConsentAllowed(), true);
  });
});

test('an unrelated env value does not accidentally allow it', () => {
  withEnvAndTTY('true', false, () => {
    assert.strictEqual(isInteractiveConsentAllowed(), false);
  });
});
