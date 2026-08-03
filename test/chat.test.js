'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { InMemoryChannel } = require('../src/core/Channel');
const { createChannelTool } = require('../src/tools/channel');
const { createChatTool } = require('../src/tools/chat');

function makePeer(channel, instanceId, displayName) {
  const channelTool = createChannelTool({ channel, instanceId, displayName });
  const chatTool = createChatTool({ getChannelTool: () => channelTool, instanceId });
  return { channelTool, chatTool };
}

test('a 1:1 conversationId is the same regardless of who starts it', async () => {
  const channel = new InMemoryChannel();
  const alice = makePeer(channel, 'alice', 'Alice');
  const bob = makePeer(channel, 'bob', 'Bob');

  const fromAlice = await alice.chatTool.invoke({ action: 'start', members: ['bob'], text: 'hi bob' });
  const fromBob = await bob.chatTool.invoke({ action: 'start', members: ['alice'], text: 'hi alice' });

  assert.strictEqual(fromAlice.result.conversationId, fromBob.result.conversationId);
});

test('starting a 1:1 delivers a chat-message the other party can poll for', async () => {
  const channel = new InMemoryChannel();
  const alice = makePeer(channel, 'alice', 'Alice');
  const bob = makePeer(channel, 'bob', 'Bob');

  const started = await alice.chatTool.invoke({ action: 'start', members: ['bob'], text: 'hi bob' });

  const bobPoll = await bob.chatTool.invoke({ action: 'poll' });
  assert.strictEqual(bobPoll.result.messages.length, 1);
  assert.strictEqual(bobPoll.result.messages[0].payload.text, 'hi bob');
  assert.strictEqual(bobPoll.result.messages[0].payload.conversationId, started.result.conversationId);
  assert.deepStrictEqual(bobPoll.result.messages[0].payload.members.sort(), ['alice', 'bob']);

  // Alice never receives her own send.
  const alicePoll = await alice.chatTool.invoke({ action: 'poll' });
  assert.strictEqual(alicePoll.result.messages.length, 0);
});

test('a group start fans out to every member, none of whom see themselves as sender', async () => {
  const channel = new InMemoryChannel();
  const alice = makePeer(channel, 'alice', 'Alice');
  const bob = makePeer(channel, 'bob', 'Bob');
  const carol = makePeer(channel, 'carol', 'Carol');

  const started = await alice.chatTool.invoke({ action: 'start', members: ['bob', 'carol'], text: 'group hi' });
  assert.deepStrictEqual(started.result.members.sort(), ['alice', 'bob', 'carol']);

  const bobPoll = await bob.chatTool.invoke({ action: 'poll' });
  assert.strictEqual(bobPoll.result.messages.length, 1);
  assert.strictEqual(bobPoll.result.messages[0].from, 'alice');

  const carolPoll = await carol.chatTool.invoke({ action: 'poll' });
  assert.strictEqual(carolPoll.result.messages.length, 1);
  assert.strictEqual(carolPoll.result.messages[0].from, 'alice');
});

test('send reaches every member of an existing conversation and reuses its conversationId', async () => {
  const channel = new InMemoryChannel();
  const alice = makePeer(channel, 'alice', 'Alice');
  const bob = makePeer(channel, 'bob', 'Bob');
  const carol = makePeer(channel, 'carol', 'Carol');

  const started = await alice.chatTool.invoke({ action: 'start', members: ['bob', 'carol'], text: 'first' });
  await bob.chatTool.invoke({ action: 'poll' }); // drain, mirroring a real client tracking its own sinceSeq
  const carolFirstPoll = await carol.chatTool.invoke({ action: 'poll' });

  const followUp = await bob.chatTool.invoke({
    action: 'send',
    conversationId: started.result.conversationId,
    members: ['alice', 'carol'],
    text: 'second',
  });
  assert.strictEqual(followUp.result.conversationId, started.result.conversationId);

  const carolPoll = await carol.chatTool.invoke({ action: 'poll', sinceSeq: carolFirstPoll.result.sinceSeq });
  assert.strictEqual(carolPoll.result.messages.length, 1);
  assert.strictEqual(carolPoll.result.messages[0].payload.text, 'second');
  assert.strictEqual(carolPoll.result.messages[0].from, 'bob');
});

test('poll only ever returns chat-message-typed entries and respects sinceSeq', async () => {
  const channel = new InMemoryChannel();
  const alice = makePeer(channel, 'alice', 'Alice');
  const bob = makePeer(channel, 'bob', 'Bob');

  await alice.channelTool.invoke({ action: 'send', to: 'bob', type: 'admin-command', payload: { command: 'update-now' } });
  const started = await alice.chatTool.invoke({ action: 'start', members: ['bob'], text: 'real chat message' });

  const firstPoll = await bob.chatTool.invoke({ action: 'poll' });
  assert.strictEqual(firstPoll.result.messages.length, 1);
  assert.strictEqual(firstPoll.result.messages[0].payload.text, 'real chat message');

  const secondPoll = await bob.chatTool.invoke({ action: 'poll', sinceSeq: firstPoll.result.sinceSeq });
  assert.strictEqual(secondPoll.result.messages.length, 0);
  void started;
});
