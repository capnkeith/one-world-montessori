'use strict';

const crypto = require('node:crypto');
const assert = require('node:assert');
const { z } = require('zod');
const { Tool } = require('../core/Tool');

/**
 * A conversation-shaped wrapper around the generic `channel` rendezvous
 * tool: a chat message is just a channel message of type 'chat-message'
 * carrying conversationId + members in its payload. No new backend, no
 * new store - conversation history inherits channel's own durability
 * (GoogleSheetsChannel never prunes messages; see its own header).
 *
 * conversationId for a plain 1:1 (exactly one other member) is a
 * deterministic sorted pair of the two instanceIds, so two people always
 * land in the same thread no matter who starts it; a group (2+ other
 * members) gets a random id. `members` (the *other* participants) is
 * always supplied by the caller rather than looked up server-side,
 * keeping this tool exactly as stateless as `channel` itself - no
 * membership registry to invent or keep in sync across machines.
 */
async function fanOutChatMessage({ channelTool, ctx, instanceId, members, conversationId, text }) {
  const allMembers = [instanceId, ...members];
  for (const to of members) {
    await ctx.call(channelTool, { action: 'send', to, type: 'chat-message', payload: { conversationId, members: allMembers, text } });
  }
  return { conversationId, members: allMembers };
}

function createChatTool({ getChannelTool, instanceId }) {
  return new Tool({
    name: 'chat',
    version: '1.0.0',
    description:
      'Real-time chat (1:1 or group) built on the channel rendezvous tool: start a conversation, send into an existing one, poll for new messages.',
    mcpInputSchema: {
      action: z.enum(['start', 'send', 'poll']).optional(),
      members: z.array(z.string()).optional(),
      conversationId: z.string().optional(),
      text: z.string().optional(),
      sinceSeq: z.number().optional(),
    },

    run: async (params, ctx) => {
      const action = params?.action ?? 'poll';
      const channelTool = getChannelTool();

      switch (action) {
        case 'start': {
          if (!Array.isArray(params.members) || params.members.length === 0) {
            throw new Error('start requires a non-empty members array');
          }
          if (!params.text) throw new Error('start requires text');
          const conversationId =
            params.members.length === 1 ? [instanceId, params.members[0]].sort().join(':') : crypto.randomUUID();
          return fanOutChatMessage({ channelTool, ctx, instanceId, members: params.members, conversationId, text: params.text });
        }

        case 'send': {
          if (!params.conversationId) throw new Error('send requires conversationId');
          if (!Array.isArray(params.members) || params.members.length === 0) {
            throw new Error('send requires a non-empty members array');
          }
          if (!params.text) throw new Error('send requires text');
          return fanOutChatMessage({
            channelTool,
            ctx,
            instanceId,
            members: params.members,
            conversationId: params.conversationId,
            text: params.text,
          });
        }

        case 'poll': {
          const { result } = await ctx.call(channelTool, { action: 'receive', sinceSeq: params?.sinceSeq ?? 0 });
          const messages = result.messages.filter((m) => m.type === 'chat-message');
          const sinceSeq = messages.reduce((max, m) => Math.max(max, m.seq), params?.sinceSeq ?? 0);
          return { messages, sinceSeq };
        }

        default:
          throw new Error(`Unknown chat action: ${action}`);
      }
    },

    internalTest: async ({ call }) => {
      const oneToOne = await call({ action: 'start', members: ['bob'], text: 'hi' });
      assert.strictEqual(oneToOne.result.conversationId, [instanceId, 'bob'].sort().join(':'));
      assert.deepStrictEqual(oneToOne.result.members.sort(), [instanceId, 'bob'].sort());

      const sameAgain = await call({ action: 'start', members: ['bob'], text: 'hi again' });
      assert.strictEqual(sameAgain.result.conversationId, oneToOne.result.conversationId, '1:1 conversationId must be stable across separate start calls');

      const group = await call({ action: 'start', members: ['bob', 'carol'], text: 'group hi' });
      assert.strictEqual(group.result.members.length, 3);
      assert.notStrictEqual(group.result.conversationId, oneToOne.result.conversationId);

      const followUp = await call({
        action: 'send',
        conversationId: group.result.conversationId,
        members: ['bob', 'carol'],
        text: 'follow up',
      });
      assert.strictEqual(followUp.result.conversationId, group.result.conversationId);

      await assert.rejects(() => call({ action: 'start', members: [], text: 'x' }), /non-empty members array/);
      await assert.rejects(() => call({ action: 'start', members: ['bob'] }), /requires text/);
      await assert.rejects(() => call({ action: 'send', members: ['bob'], text: 'x' }), /requires conversationId/);

      const polled = await call({ action: 'poll' });
      assert.ok(Array.isArray(polled.result.messages));
      assert.strictEqual(typeof polled.result.sinceSeq, 'number');

      return { passed: true };
    },

    realWorldTest: async (testConfig, { call }) => {
      const { result } = await call({ action: 'poll' });
      assert.ok(Array.isArray(result.messages));
      return { passed: true, checkedAgainst: testConfig.label ?? 'unnamed-fixture' };
    },
  });
}

module.exports = { createChatTool };
