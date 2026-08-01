'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InMemoryChannel } = require('../src/core/Channel');
const { createChannelTool } = require('../src/tools/channel');
const { createContext } = require('../src/context');

function tempStateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'owm-channel-test-'));
}

test('announce carries this instance\'s own tool names, visible to other peers via list', async () => {
  const channel = new InMemoryChannel();
  const alice = createChannelTool({
    channel,
    instanceId: 'alice',
    displayName: 'Alice',
    toolSetRef: () => ({ list: () => [{ name: 'drive' }, { name: 'channel' }] }),
  });
  const bob = createChannelTool({ channel, instanceId: 'bob', displayName: 'Bob' });

  const announced = await alice.invoke({ action: 'announce' });
  assert.deepStrictEqual(announced.result.tools, ['drive', 'channel']);

  const { result } = await bob.invoke({ action: 'list' });
  const aliceEntry = result.peers.find((p) => p.instanceId === 'alice');
  assert.deepStrictEqual(aliceEntry.tools, ['drive', 'channel']);
});

test('a peer with no toolSetRef configured (the default) announces an empty tool list, not an error', async () => {
  const channel = new InMemoryChannel();
  const tool = createChannelTool({ channel, instanceId: 'x', displayName: 'X' });
  const announced = await tool.invoke({ action: 'announce' });
  assert.deepStrictEqual(announced.result.tools, []);
});

test('two peers sharing a channel discover each other after announcing', async () => {
  const channel = new InMemoryChannel();
  const alice = createChannelTool({ channel, instanceId: 'alice', displayName: 'Alice' });
  const bob = createChannelTool({ channel, instanceId: 'bob', displayName: 'Bob' });

  await alice.invoke({ action: 'announce' });
  await bob.invoke({ action: 'announce' });

  const { result } = await alice.invoke({ action: 'list' });
  assert.deepStrictEqual(result.peers.map((p) => p.instanceId).sort(), ['alice', 'bob']);
});

test('arbitrary JSON-serializable payloads transmit from one peer to another', async () => {
  const channel = new InMemoryChannel();
  const alice = createChannelTool({ channel, instanceId: 'alice', displayName: 'Alice' });
  const bob = createChannelTool({ channel, instanceId: 'bob', displayName: 'Bob' });

  const payload = { nested: { numbers: [1, 2, 3], flag: true, note: 'anything JSON-serializable' } };
  await alice.invoke({ action: 'send', to: 'bob', type: 'custom-data', payload });

  const { result } = await bob.invoke({ action: 'receive' });
  assert.strictEqual(result.messages.length, 1);
  assert.strictEqual(result.messages[0].from, 'alice');
  assert.strictEqual(result.messages[0].type, 'custom-data');
  assert.deepStrictEqual(result.messages[0].payload, payload);
});

test('broadcast reaches every other peer, never the sender, and sinceSeq avoids re-delivery', async () => {
  const channel = new InMemoryChannel();
  const alice = createChannelTool({ channel, instanceId: 'alice', displayName: 'Alice' });
  const bob = createChannelTool({ channel, instanceId: 'bob', displayName: 'Bob' });
  const carol = createChannelTool({ channel, instanceId: 'carol', displayName: 'Carol' });

  const sent = await alice.invoke({ action: 'send', payload: 'hi everyone' });
  const seq = sent.result.seq;

  const bobFirst = await bob.invoke({ action: 'receive' });
  assert.strictEqual(bobFirst.result.messages.length, 1);

  const bobAgain = await bob.invoke({ action: 'receive', sinceSeq: seq });
  assert.strictEqual(bobAgain.result.messages.length, 0);

  const carolFirst = await carol.invoke({ action: 'receive' });
  assert.strictEqual(carolFirst.result.messages.length, 1);

  const aliceOwnInbox = await alice.invoke({ action: 'receive' });
  assert.strictEqual(aliceOwnInbox.result.messages.length, 0);
});

test('stale peers drop out of the online list', async () => {
  const channel = new InMemoryChannel({ staleAfterMs: 10 });
  const tool = createChannelTool({ channel, instanceId: 'x', displayName: 'X' });
  await tool.invoke({ action: 'announce' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const { result } = await tool.invoke({ action: 'list' });
  assert.strictEqual(result.peers.length, 0);
});

test('two full contexts (as if two separate machines) see each other over a shared channel', async () => {
  const sharedChannel = new InMemoryChannel();
  const machineA = createContext({ stateRoot: tempStateRoot(), channel: sharedChannel });
  const machineB = createContext({ stateRoot: tempStateRoot(), channel: sharedChannel });

  await machineA.toolSet.invoke('channel', { action: 'announce' });
  await machineB.toolSet.invoke('channel', { action: 'announce' });

  const { result } = await machineA.toolSet.invoke('channel', { action: 'list' });
  const instanceIds = result.peers.map((p) => p.instanceId).sort();
  assert.deepStrictEqual(instanceIds, [machineA.instanceId, machineB.instanceId].sort());
});
