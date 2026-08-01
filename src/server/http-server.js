#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createContext } = require('../context');
const { HTTP_DEFAULT_PORT } = require('../core/paths');

const SAMPLE_APP_PATH = path.join(__dirname, '..', '..', 'sample-app', 'index.html');

/**
 * Local HTTP front end for consumers that can't launch/pipe an MCP
 * server directly (e.g. a browser-based sample app). Same shared
 * ToolSet as the CLI and the MCP stdio server — this file only adds
 * transport, not behavior.
 *
 * CORS is wide open here for the sample. A real deployment should
 * restrict Access-Control-Allow-Origin to the sample app's actual
 * origin rather than '*'.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
    req.on('error', reject);
  });
}

function startServer({ port = HTTP_DEFAULT_PORT, stateRoot, announceIntervalMs = 30_000 } = {}) {
  const { toolSet } = createContext({ stateRoot });

  // Presence should reflect that this server process is alive, not
  // whether anyone has the sample app's browser tab open — announce
  // immediately on startup and keep refreshing on an interval so this
  // instance doesn't go stale in other peers' `channel` lists.
  const announce = () => {
    toolSet.invoke('channel', { action: 'announce' }).catch((err) => {
      console.error('presence announce failed:', err.message);
    });
  };
  announce();
  const announceInterval = setInterval(announce, announceIntervalMs);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url, `http://localhost:${port}`);

      // Serves the sample app itself so a landing page (e.g. GitHub Pages)
      // can hand off to an already-running local install with a plain
      // navigation (location.href), no custom protocol handler needed.
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(SAMPLE_APP_PATH));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/tools') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(toolSet.list()));
        return;
      }

      const invokeMatch = url.pathname.match(/^\/tools\/([^/]+)\/invoke$/);
      if (req.method === 'POST' && invokeMatch) {
        const toolName = invokeMatch[1];
        const params = await readBody(req);
        const { result, versionLineage } = await toolSet.invoke(toolName, params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result, versionLineage }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.on('close', () => clearInterval(announceInterval));
  server.listen(port, '127.0.0.1');
  return server;
}

if (require.main === module) {
  const port = Number(process.env.OWM_HTTP_PORT) || HTTP_DEFAULT_PORT;
  const server = startServer({ port });
  server.on('listening', () => {
    console.log(`OWM local HTTP server listening on http://127.0.0.1:${port}`);
  });
}

module.exports = { startServer };
