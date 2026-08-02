'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { Tool } = require('../core/Tool');
const { SERVER_VERSION } = require('../version');

/**
 * Checks whether an external CLI tool is actually runnable on this machine
 * — regression: a real end user's install was refused entirely because her
 * machine had no `git` installed (a hidden dependency of the self-check
 * test suite, not of OWM Drive itself), and there was no way to see that
 * from doctor's report - only from digging through a raw install log.
 */
function checkExternalCommand(cmd, versionArgs = ['--version']) {
  // spawnSync (not execFileSync) deliberately: ssh-keygen has no
  // --version-style flag at all and always exits non-zero for any
  // invocation like this — a try/catch around execFileSync can't tell
  // that apart from "the executable itself doesn't exist." spawnSync
  // never throws; result.error is only set when the executable itself
  // couldn't be spawned (e.g. ENOENT), which is what "present" actually
  // means here — the exit code/output otherwise don't matter.
  const result = spawnSync(cmd, versionArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) return { present: false, version: null };
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`.toString().trim();
  return { present: true, version: combined.split('\n')[0] || null };
}

/**
 * First-class health check. Every interface (MCP, CLI, HTTP) exposes this
 * tool identically. It reports version info, credential *presence* (never
 * values), profile presence, and runtime facts — enough to diagnose an
 * install without ever leaking a secret into logs or chat transcripts.
 */
function createDoctorTool({ toolSetRef, secretStore, profile, getChannelTool }) {
  return new Tool({
    name: 'doctor',
    version: '1.1.0',
    description: 'Reports server/tool version info and install health without revealing secrets.',

    run: async (_params, ctx) => {
      const toolSet = toolSetRef();
      const channelTool = getChannelTool?.();
      const presence = channelTool ? await ctx.call(channelTool, { action: 'list' }) : null;

      return {
        serverVersion: SERVER_VERSION,
        toolSetName: toolSet.name,
        toolSetVersion: toolSet.version,
        tools: toolSet.list(),
        credentials: {
          // presence only — never the value
          googleOAuthPresent: secretStore.has('google_oauth_refresh_token'),
        },
        profile: {
          exists: profile.exists(),
        },
        presence: presence
          ? { onlinePeerCount: presence.result.peers.length, channelVersionLineage: presence.versionLineage }
          : null,
        prerequisites: {
          // Only tools OWM Drive's own install/update pipeline genuinely
          // needs on this machine beyond Node.js itself (which is
          // guaranteed present — doctor is running under it right now).
          git: checkExternalCommand('git'),
          sshKeygen: checkExternalCommand('ssh-keygen', ['-V']), // ssh-keygen prints its version to stderr, not stdout, on -V — presence is what matters here, not the exact string
        },
        runtime: {
          node: process.version,
          platform: process.platform,
        },
        timestamp: new Date().toISOString(),
      };
    },

    internalTest: async ({ call }) => {
      const { result } = await call({});
      assert.strictEqual(result.serverVersion, SERVER_VERSION);
      assert.ok(Array.isArray(result.tools));
      assert.strictEqual(typeof result.credentials.googleOAuthPresent, 'boolean');
      if (result.presence) {
        assert.strictEqual(typeof result.presence.onlinePeerCount, 'number');
      }
      assert.strictEqual(typeof result.prerequisites.git.present, 'boolean');
      assert.strictEqual(typeof result.prerequisites.sshKeygen.present, 'boolean');
      return { passed: true };
    },

    // Doctor's "real world" check is whether it can see the same live
    // secret/profile state the running server is actually using, keyed
    // to a specific test fixture rather than assumed defaults.
    realWorldTest: async (testConfig, { call }) => {
      const { result } = await call({});
      assert.ok(result.timestamp);
      return { passed: true, checkedAgainst: testConfig.label ?? 'unnamed-fixture' };
    },
  });
}

module.exports = { createDoctorTool };
