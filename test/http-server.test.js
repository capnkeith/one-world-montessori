'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../src/server/http-server');

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
