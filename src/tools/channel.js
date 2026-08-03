'use strict';

const assert = require('node:assert');
const { z } = require('zod');
const { Tool } = require('../core/Tool');

/**
 * Peer rendezvous + messaging, exposed identically across CLI/MCP/HTTP.
 * Backed by whatever Channel implementation the context wires in
 * (src/core/Channel.js's InMemoryChannel by default; a real cross-machine
 * backend like GoogleSheetsChannel plugs into the same four methods — see
 * `setup` below for how a node opts into using one).
 */
function createChannelTool({ channel, instanceId, displayName, secretStore, toolSetRef = () => ({ list: () => [] }) }) {
  return new Tool({
    name: 'channel',
    version: '1.4.0',
    description: 'Peer rendezvous + messaging: announce presence (real Google name/photo when Drive is set up, plus this instance\'s own tool list), list online peers, send/receive arbitrary data.',
    mcpInputSchema: {
      action: z.enum(['announce', 'list', 'send', 'receive', 'setup']).optional(),
      to: z.string().optional(),
      type: z.string().optional(),
      payload: z.any().optional(),
      sinceSeq: z.number().optional(),
      serviceAccountKeyJson: z.string().optional(),
      spreadsheetId: z.string().optional(),
    },

    // ctx.user is resolved once per ToolSet (see ToolSet.invoke /
    // src/core/identity.js) — the real Google name/photo behind whichever
    // account this instance is running as, falling back to the plain
    // local displayName when ctx.user isn't populated (e.g. this tool's
    // own internalTest calls run() directly via Tool.invoke, which never
    // sets ctx.user itself — only ToolSet.invoke does).
    run: async (params, ctx) => {
      const action = params?.action ?? 'list';
      const user = ctx?.user ?? { displayName, photoLink: undefined };
      switch (action) {
        // Same shape as drive/dropbox's own `setup`: stores a credential
        // this node needs in its own local SecretStore, encrypted at rest.
        // Cross-machine presence only works once every node that should
        // see each other has been given this same key + spreadsheetId —
        // there's no automatic distribution (see GoogleSheetsChannel.js's
        // header for why a raw service-account key is never bundled in
        // the repo the way the Drive OAuth client is). A process needs
        // restarting after this for it to take effect, since the channel
        // backend is constructed once at startup (src/context.js), not
        // re-checked on every call.
        case 'setup': {
          if (!params.serviceAccountKeyJson) throw new Error('setup requires serviceAccountKeyJson');
          if (!params.spreadsheetId) throw new Error('setup requires spreadsheetId');
          JSON.parse(params.serviceAccountKeyJson); // throws clearly here rather than failing obscurely later
          secretStore.set('channel_service_account_key', params.serviceAccountKeyJson);
          secretStore.set('channel_spreadsheet_id', params.spreadsheetId);
          return { configured: true };
        }

        case 'announce': {
          const tools = toolSetRef().list().map((t) => t.name);
          const toolSetVersion = toolSetRef().version;
          await channel.announce({ instanceId, displayName: user.displayName, photoLink: user.photoLink, tools, toolSetVersion });
          return { announced: true, instanceId, displayName: user.displayName, photoLink: user.photoLink, tools, toolSetVersion };
        }

        case 'list': {
          const tools = toolSetRef().list().map((t) => t.name);
          const toolSetVersion = toolSetRef().version;
          return {
            self: { instanceId, displayName: user.displayName, photoLink: user.photoLink, tools, toolSetVersion },
            peers: await channel.list(),
          };
        }

        case 'send': {
          const receipt = await channel.send({
            from: instanceId,
            to: params.to ?? 'broadcast',
            type: params.type,
            payload: params.payload,
          });
          return { sent: true, ...receipt };
        }

        case 'receive':
          return { messages: await channel.receive({ instanceId, sinceSeq: params?.sinceSeq ?? 0 }) };

        default:
          throw new Error(`Unknown channel action: ${action}`);
      }
    },

    internalTest: async ({ call }) => {
      const announced = await call({ action: 'announce' });
      assert.strictEqual(announced.result.announced, true);
      assert.strictEqual(typeof announced.result.toolSetVersion, 'string', 'announce must report this instance\'s own toolset version');

      const listed = await call({ action: 'list' });
      assert.ok(listed.result.peers.some((p) => p.instanceId === instanceId));
      assert.strictEqual(listed.result.self.toolSetVersion, announced.result.toolSetVersion, 'list must report the same version for self as announce did');
      assert.ok(
        listed.result.peers.find((p) => p.instanceId === instanceId).toolSetVersion,
        'a peer\'s own toolSetVersion must round-trip through announce -> list, not just be present on self'
      );

      const sent = await call({ action: 'send', payload: { hello: 'world' }, type: 'greeting' });
      assert.strictEqual(sent.result.sent, true);
      assert.ok(sent.result.seq >= 1);

      const configured = await call({
        action: 'setup',
        serviceAccountKeyJson: JSON.stringify({ client_email: 'fake@example.iam.gserviceaccount.com', private_key: 'fake' }),
        spreadsheetId: 'fake-sheet-id',
      });
      assert.strictEqual(configured.result.configured, true);
      assert.ok(secretStore.has('channel_service_account_key'));
      assert.ok(secretStore.has('channel_spreadsheet_id'));

      await assert.rejects(() => call({ action: 'setup', spreadsheetId: 'x' }), /requires serviceAccountKeyJson/);
      await assert.rejects(() => call({ action: 'setup', serviceAccountKeyJson: 'not json', spreadsheetId: 'x' }), SyntaxError);

      return { passed: true };
    },

    realWorldTest: async (testConfig, { call }) => {
      const { result } = await call({ action: 'list' });
      assert.ok(Array.isArray(result.peers));
      return { passed: true, checkedAgainst: testConfig.label ?? 'unnamed-fixture' };
    },
  });
}

module.exports = { createChannelTool };
