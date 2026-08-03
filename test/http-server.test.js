'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../src/server/http-server');
const { InMemoryChannel } = require('../src/core/Channel');

function tempStateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'owm-http-test-'));
}

function listen(server) {
  return new Promise((resolve) => server.on('listening', resolve));
}

test('GET /tools lists registered tools; POST /tools/:name/invoke calls them', async () => {
  // Honors OWM_TEST_PORT so the bootstrap installer's staging run binds a
  // known isolated port instead of colliding with a live install; falls
  // back to an OS-assigned ephemeral port for plain `npm test` runs.
  const requestedPort = Number(process.env.OWM_TEST_PORT) || 0;
  const server = startServer({ port: requestedPort, stateRoot: tempStateRoot() });
  await listen(server);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const listRes = await fetch(`${base}/tools`);
    const tools = await listRes.json();
    assert.ok(tools.some((t) => t.name === 'doctor'));
    // Chrome's Private Network Access blocks a public HTTPS page (the
    // GitHub Pages landing page) from fetching this private/local address
    // without this header — without it, the landing page's "is OWM Drive
    // already running?" probe silently fails even when it's up.
    assert.strictEqual(listRes.headers.get('access-control-allow-private-network'), 'true');

    const invokeRes = await fetch(`${base}/tools/echo/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'from-http' }),
    });
    const body = await invokeRes.json();
    assert.strictEqual(body.result.echoed, 'from-http');
  } finally {
    server.close();
  }
});

test('GET / and GET /index.html serve the sample app so a landing page can hand off with a plain navigation', async () => {
  const server = startServer({ port: 0, stateRoot: tempStateRoot() });
  await listen(server);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    for (const route of ['/', '/index.html']) {
      const res = await fetch(`${base}${route}`);
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/html/);
      const body = await res.text();
      assert.match(body, /<title>OWM Drive<\/title>/);
    }
  } finally {
    server.close();
  }
});

test('GET /status.html serves the real-time compute-node/job/queue monitoring page', async () => {
  const server = startServer({ port: 0, stateRoot: tempStateRoot() });
  await listen(server);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${base}/status.html`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const body = await res.text();
    assert.match(body, /<title>OWM Status<\/title>/);
    // The inspect/edit panel must actually be wired to the scheduler
    // tool's real mutating actions, not just list jobs read-only.
    for (const action of ['getJob', 'updateJob', 'pauseJob', 'resumeJob', 'cancelJob', 'runJob', 'testJob']) {
      assert.ok(body.includes(action), `status page must wire up the scheduler '${action}' action`);
    }
  } finally {
    server.close();
  }
});

test('POST /tools/:name/invoke for an unknown tool returns 500 with an error body', async () => {
  const server = startServer({ port: 0, stateRoot: tempStateRoot() });
  await listen(server);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/tools/nope/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /Unknown tool/);
  } finally {
    server.close();
  }
});

test('an admin-command "update-now" message from another peer triggers the update-and-exit hook', async () => {
  const sharedChannel = new InMemoryChannel();
  let updateCalled = false;
  const server = startServer({
    port: 0,
    stateRoot: tempStateRoot(),
    channel: sharedChannel,
    adminPollIntervalMs: 20,
    runUpdateAndExit: () => {
      updateCalled = true;
    },
  });
  await listen(server);

  try {
    // Simulates another peer instance sending the command — 'broadcast'
    // since the test doesn't know this server's auto-generated instanceId.
    await sharedChannel.send({ from: 'other-peer', to: 'broadcast', type: 'admin-command', payload: { command: 'update-now' } });

    const deadline = Date.now() + 2000;
    while (!updateCalled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.strictEqual(updateCalled, true);
  } finally {
    server.close();
  }
});

test('a restarted server never replays an already-handled update-now command (regression: real crash-loop incident, 2026-08-03)', async () => {
  const sharedChannel = new InMemoryChannel();
  const sharedStateRoot = tempStateRoot();
  let firstInstanceUpdateCalls = 0;

  const first = startServer({
    port: 0,
    stateRoot: sharedStateRoot,
    channel: sharedChannel,
    adminPollIntervalMs: 20,
    runUpdateAndExit: () => {
      firstInstanceUpdateCalls += 1;
    },
  });
  await listen(first);

  try {
    await sharedChannel.send({ from: 'other-peer', to: 'broadcast', type: 'admin-command', payload: { command: 'update-now' } });

    let deadline = Date.now() + 2000;
    while (firstInstanceUpdateCalls < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.strictEqual(firstInstanceUpdateCalls, 1, 'the first instance must handle the real command exactly once');

    // Give the watermark save a moment to land on disk before "restarting".
    await new Promise((resolve) => setTimeout(resolve, 50));
    first.close();

    // Simulates exactly what happened on the real machine: the process
    // restarts (same stateRoot, so the persisted watermark carries over)
    // while the SAME message is still sitting in the channel's history
    // (it hasn't been re-sent - this is the one message from before).
    let secondInstanceUpdateCalls = 0;
    const second = startServer({
      port: 0,
      stateRoot: sharedStateRoot,
      channel: sharedChannel,
      adminPollIntervalMs: 20,
      runUpdateAndExit: () => {
        secondInstanceUpdateCalls += 1;
      },
    });
    await listen(second);

    try {
      // Let several poll cycles pass - the bug would call runUpdateAndExit
      // on the very first one.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.strictEqual(secondInstanceUpdateCalls, 0, 'a restarted instance must never replay a command it already handled before restarting');
    } finally {
      second.close();
    }
  } finally {
    try {
      first.close();
    } catch {
      // already closed above in the success path
    }
  }
});

test('an unrelated broadcast message never triggers the update-and-exit hook', async () => {
  const sharedChannel = new InMemoryChannel();
  let updateCalled = false;
  const server = startServer({
    port: 0,
    stateRoot: tempStateRoot(),
    channel: sharedChannel,
    adminPollIntervalMs: 20,
    runUpdateAndExit: () => {
      updateCalled = true;
    },
  });
  await listen(server);

  try {
    await sharedChannel.send({ from: 'other-peer', to: 'broadcast', type: 'greeting', payload: { hello: 'world' } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(updateCalled, false);
  } finally {
    server.close();
  }
});
