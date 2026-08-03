'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PromptQueue } = require('../src/core/PromptQueue');

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

test('submit creates an unanswered, unclaimed prompt', () => {
  const queue = new PromptQueue({ store: fakeStore() });
  const prompt = queue.submit({ query: 'what is in my root folder?', now: new Date(2026, 7, 1) });
  assert.ok(prompt.id);
  assert.strictEqual(prompt.query, 'what is in my root folder?');
  assert.strictEqual(prompt.answeredAt, null);
  assert.strictEqual(prompt.claimedBy, null);
});

test('submit requires a query', () => {
  const queue = new PromptQueue({ store: fakeStore() });
  assert.throws(() => queue.submit({}), /requires query/);
});

test('submit carries the asking user along, defaulting to null when not given', () => {
  const queue = new PromptQueue({ store: fakeStore() });
  const withUser = queue.submit({ query: 'what is in the OWM folder?', user: { email: 'seth@oneworldmontessori.org' } });
  assert.deepStrictEqual(withUser.user, { email: 'seth@oneworldmontessori.org' });

  const withoutUser = queue.submit({ query: 'hi' });
  assert.strictEqual(withoutUser.user, null);
});

test('claimPrompt lets one node claim it, blocking a second node while the lease is live', () => {
  const store = fakeStore();
  const queue = new PromptQueue({ store });
  const prompt = queue.submit({ query: 'hi', now: new Date(2026, 7, 1) });
  const now = new Date(2026, 7, 1, 0, 1);

  const claimed = queue.claimPrompt({ id: prompt.id, nodeId: 'node-a', now });
  assert.strictEqual(claimed.claimedBy, 'node-a');

  assert.throws(
    () => queue.claimPrompt({ id: prompt.id, nodeId: 'node-b', now: new Date(now.getTime() + 1000) }),
    /already claimed by node-a/
  );
});

test('claimPrompt lets a second node take over once the first node\'s lease has expired (failover)', () => {
  const store = fakeStore();
  const queue = new PromptQueue({ store });
  const prompt = queue.submit({ query: 'hi', now: new Date(2026, 7, 1) });
  const now = new Date(2026, 7, 1, 0, 1);

  queue.claimPrompt({ id: prompt.id, nodeId: 'node-a', now, leaseMs: 60_000 });

  const wellAfterExpiry = new Date(now.getTime() + 120_000);
  const reclaimed = queue.claimPrompt({ id: prompt.id, nodeId: 'node-b', now: wellAfterExpiry });
  assert.strictEqual(reclaimed.claimedBy, 'node-b', 'a node that disappeared mid-answer must not permanently block another node');
});

test('claimPrompt lets the same node re-claim without error', () => {
  const store = fakeStore();
  const queue = new PromptQueue({ store });
  const prompt = queue.submit({ query: 'hi', now: new Date(2026, 7, 1) });
  const now = new Date(2026, 7, 1, 0, 1);

  queue.claimPrompt({ id: prompt.id, nodeId: 'node-a', now });
  const reclaimed = queue.claimPrompt({ id: prompt.id, nodeId: 'node-a', now: new Date(now.getTime() + 1000) });
  assert.strictEqual(reclaimed.claimedBy, 'node-a');
});

test('claimPrompt refuses to claim an already-answered prompt', () => {
  const store = fakeStore();
  const queue = new PromptQueue({ store });
  const prompt = queue.submit({ query: 'hi', now: new Date(2026, 7, 1) });
  queue.recordAnswer({ id: prompt.id, answer: 'here you go' });

  assert.throws(() => queue.claimPrompt({ id: prompt.id, nodeId: 'node-a' }), /already answered/);
});

test('claimPrompt throws a clear error for a nonexistent prompt', () => {
  const queue = new PromptQueue({ store: fakeStore() });
  assert.throws(() => queue.claimPrompt({ id: 'not-a-real-id', nodeId: 'node-a' }), /No prompt with id/);
});

test('recordAnswer sets the answer and releases the claim', () => {
  const store = fakeStore();
  const queue = new PromptQueue({ store });
  const prompt = queue.submit({ query: 'hi', now: new Date(2026, 7, 1) });
  queue.claimPrompt({ id: prompt.id, nodeId: 'node-a' });

  const answered = queue.recordAnswer({ id: prompt.id, answer: 'here you go', now: new Date(2026, 7, 1, 0, 2) });
  assert.strictEqual(answered.answer, 'here you go');
  assert.ok(answered.answeredAt);
  assert.strictEqual(answered.claimedBy, null);
  assert.strictEqual(answered.claimedAt, null);
  assert.strictEqual(answered.leaseExpiresAt, null);
});

test('recordAnswer accepts a structured { text, entries } answer just as freely as a plain string (the class itself is answer-shape-agnostic; the promptQueue tool enforces the real shape)', () => {
  const store = fakeStore();
  const queue = new PromptQueue({ store });
  const prompt = queue.submit({ query: 'what is in the OWM folder?' });

  const entries = [{ id: 'folder-1', name: 'OWM', mimeType: 'application/vnd.google-apps.folder', isFolder: true }];
  const answered = queue.recordAnswer({ id: prompt.id, answer: { text: 'One folder found.', entries } });
  assert.deepStrictEqual(answered.answer, { text: 'One folder found.', entries });
});

test('getPrompt returns null for an id that does not exist, listPrompts returns everything', () => {
  const store = fakeStore();
  const queue = new PromptQueue({ store });
  assert.strictEqual(queue.getPrompt('nope'), null);

  queue.submit({ query: 'one' });
  queue.submit({ query: 'two' });
  assert.strictEqual(queue.listPrompts().length, 2);
});
