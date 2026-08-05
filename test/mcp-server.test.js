'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { MCP_INSTRUCTIONS, buildMcpServer } = require('../src/server/mcp-server');
const { InMemoryChannel } = require('../src/core/Channel');
const { createContext } = require('../src/context');

function tempStateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'owm-mcp-server-test-'));
}

// Regression (2026-08-03): a new Claude compute node connecting over MCP
// had no automatic signal to call the `worker` tool's `register` action
// (see WORKER.md) - it was just one tool among many, easy to never
// notice. This exercises the REAL MCP handshake (via the SDK's own
// Client, not a hand-rolled stand-in) to prove the `instructions` field
// actually reaches a connecting client, the way Claude Code itself
// would receive it.
test('a connecting MCP client receives instructions directing it to worker.register', async () => {
  const server = new McpServer({ name: 'owm-mcp-test', version: '0.0.0' }, { instructions: MCP_INSTRUCTIONS });
  server.registerTool('worker', { description: 'fake worker tool for this test' }, async () => ({ content: [] }));

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const instructions = client.getInstructions();
  assert.ok(instructions, 'the server must actually send instructions during the real MCP initialize handshake');
  assert.match(instructions, /worker/, 'must point at the worker tool by name');
  assert.match(instructions, /register/, 'must point at the register action by name');

  await client.close();
  await server.close();
});

// Regression (2026-08-05): presence only ever came from http-server.js's
// own announce loop, so a node connected purely over MCP (no local HTTP
// server/sample app running at all) never showed up as an online peer,
// even though it's a genuinely live compute node. This proves a real MCP
// connection can announce itself onto a shared channel independent of
// the HTTP front end entirely.
test('a live MCP connection announces presence on the shared channel, with no HTTP server involved', async () => {
  const channel = new InMemoryChannel();
  const { toolSet, instanceId } = createContext({ stateRoot: tempStateRoot(), channel });
  const { server, announce } = buildMcpServer({ toolSet });

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  await announce();

  const { result } = await toolSet.invoke('channel', { action: 'list' });
  assert.ok(
    result.peers.some((p) => p.instanceId === instanceId),
    'the MCP connection itself must be able to announce presence, not just the HTTP server'
  );

  await client.close();
  await server.close();
});
