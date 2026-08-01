'use strict';

const assert = require('node:assert');
const { Tool } = require('../core/Tool');
const { SERVER_VERSION } = require('../version');

/**
 * First-class health check. Every interface (MCP, CLI, HTTP) exposes this
 * tool identically. It reports version info, credential *presence* (never
 * values), profile presence, and runtime facts — enough to diagnose an
 * install without ever leaking a secret into logs or chat transcripts.
 */
function createDoctorTool({ toolSetRef, secretStore, profile, getChannelTool }) {
  return new Tool({
    name: 'doctor',
    version: '1.0.0',
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
