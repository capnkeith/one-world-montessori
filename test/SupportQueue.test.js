'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SupportQueue } = require('../src/core/SupportQueue');

function fakeStore(initial = []) {
  let items = initial;
  return {
    load: () => items,
    save: (next) => {
      items = next;
    },
    mutate: (id, updaterFn) => {
      const item = items.find((i) => i.id === id);
      if (!item) return null;
      return updaterFn(item) ? item : null;
    },
  };
}

test('registerIfNew creates an open, unclaimed ticket', () => {
  const queue = new SupportQueue({ store: fakeStore() });
  const ticket = queue.registerIfNew({
    messageId: 'msg-1',
    threadId: 'thread-1',
    category: 'tech-support',
    from: 'Rebecca <rebecca@oneworldmontessori.org>',
    subject: 'tech support: help',
    body: 'it broke',
    now: new Date(2026, 7, 1),
  });
  assert.ok(ticket.id);
  assert.strictEqual(ticket.messageId, 'msg-1');
  assert.strictEqual(ticket.resolvedAt, null);
  assert.strictEqual(ticket.claimedBy, null);
});

test('registerIfNew is idempotent by messageId, returns null the second time', () => {
  const queue = new SupportQueue({ store: fakeStore() });
  const args = { messageId: 'msg-1', threadId: 't1', category: 'general', from: 'x@example.com', subject: 'general: hi', body: 'hi' };
  const first = queue.registerIfNew(args);
  assert.ok(first);
  const second = queue.registerIfNew(args);
  assert.strictEqual(second, null);
  assert.strictEqual(queue.listTickets().length, 1);
});

test('claimTicket lets one node claim it, blocking a second node while the lease is live', () => {
  const store = fakeStore();
  const queue = new SupportQueue({ store });
  const ticket = queue.registerIfNew({ messageId: 'm', threadId: 't', category: 'general', from: 'x', subject: 's', body: 'b', now: new Date(2026, 7, 1) });
  const now = new Date(2026, 7, 1, 0, 1);

  const claimed = queue.claimTicket({ id: ticket.id, nodeId: 'node-a', now });
  assert.strictEqual(claimed.claimedBy, 'node-a');

  assert.throws(
    () => queue.claimTicket({ id: ticket.id, nodeId: 'node-b', now: new Date(now.getTime() + 1000) }),
    /already claimed by node-a/
  );
});

test('claimTicket lets a second node take over once the first node\'s lease has expired (failover)', () => {
  const store = fakeStore();
  const queue = new SupportQueue({ store });
  const ticket = queue.registerIfNew({ messageId: 'm', threadId: 't', category: 'general', from: 'x', subject: 's', body: 'b', now: new Date(2026, 7, 1) });
  const now = new Date(2026, 7, 1, 0, 1);

  queue.claimTicket({ id: ticket.id, nodeId: 'node-a', now, leaseMs: 60_000 });
  const wellAfterExpiry = new Date(now.getTime() + 120_000);
  const reclaimed = queue.claimTicket({ id: ticket.id, nodeId: 'node-b', now: wellAfterExpiry });
  assert.strictEqual(reclaimed.claimedBy, 'node-b');
});

test('claimTicket refuses to claim an already-resolved ticket', () => {
  const store = fakeStore();
  const queue = new SupportQueue({ store });
  const ticket = queue.registerIfNew({ messageId: 'm', threadId: 't', category: 'general', from: 'x', subject: 's', body: 'b' });
  queue.resolveTicket({ id: ticket.id, replyText: 'done' });
  assert.throws(() => queue.claimTicket({ id: ticket.id, nodeId: 'node-a' }), /already resolved/);
});

test('claimTicket throws a clear error for a nonexistent ticket', () => {
  const queue = new SupportQueue({ store: fakeStore() });
  assert.throws(() => queue.claimTicket({ id: 'not-a-real-id', nodeId: 'node-a' }), /No ticket with id/);
});

test('resolveTicket sets replyText/resolvedAt and releases the claim', () => {
  const store = fakeStore();
  const queue = new SupportQueue({ store });
  const ticket = queue.registerIfNew({ messageId: 'm', threadId: 't', category: 'general', from: 'x', subject: 's', body: 'b' });
  queue.claimTicket({ id: ticket.id, nodeId: 'node-a' });

  const resolved = queue.resolveTicket({ id: ticket.id, replyText: 'here is the answer', now: new Date(2026, 7, 1, 0, 2) });
  assert.strictEqual(resolved.replyText, 'here is the answer');
  assert.ok(resolved.resolvedAt);
  assert.strictEqual(resolved.claimedBy, null);
  assert.strictEqual(resolved.claimedAt, null);
  assert.strictEqual(resolved.leaseExpiresAt, null);
});

test('getTicket returns null for an id that does not exist, listTickets returns everything', () => {
  const store = fakeStore();
  const queue = new SupportQueue({ store });
  assert.strictEqual(queue.getTicket('nope'), null);

  queue.registerIfNew({ messageId: 'm1', threadId: 't1', category: 'general', from: 'x', subject: 's1', body: 'b1' });
  queue.registerIfNew({ messageId: 'm2', threadId: 't2', category: 'tech-support', from: 'y', subject: 's2', body: 'b2' });
  assert.strictEqual(queue.listTickets().length, 2);
});
