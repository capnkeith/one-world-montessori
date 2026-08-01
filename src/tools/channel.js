'use strict';

const assert = require('node:assert');
const { z } = require('zod');
const { Tool } = require('../core/Tool');

/**
 * Peer rendezvous + messaging, exposed identically across CLI/MCP/HTTP.
 * Backed by whatever Channel implementation the context wires in
 * (src/core/Channel.js's InMemoryChannel by default; a real cross-machine
 * backend like GoogleSheetsChannel plugs into the same four methods).
 */
function createChannelTool({ channel, instanceId, displayName, toolSetRef = () => ({ list: () => [] }) }) {
  return new Tool({
    name: 'channel',
    version: '1.1.0',
    description: 'Peer rendezvous + messaging: announce presence (including this instance\'s own tool list), list online peers, send/receive arbitrary data.',
    mcpInputSchema: {
      action: z.enum(['announce', 'list', 'send', 'receive']).optional(),
      to: z.string().optional(),
      type: z.string().optional(),
      payload: z.any().optional(),
      sinceSeq: z.number().optional(),
    },

    run: async (params) => {
      const action = params?.action ?? 'list';
      switch (action) {
        case 'announce': {
          const tools = toolSetRef().list().map((t) => t.name);
          await channel.announce({ instanceId, displayName, tools });
          return { announced: true, instanceId, displayName, tools };
        }

        case 'list': {
          const tools = toolSetRef().list().map((t) => t.name);
          return { self: { instanceId, displayName, tools }, peers: await channel.list() };
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

      const listed = await call({ action: 'list' });
      assert.ok(listed.result.peers.some((p) => p.instanceId === instanceId));

      const sent = await call({ action: 'send', payload: { hello: 'world' }, type: 'greeting' });
      assert.strictEqual(sent.result.sent, true);
      assert.ok(sent.result.seq >= 1);
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
