#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createContext } = require('../context');
const { HTTP_DEFAULT_PORT } = require('../core/paths');

const SAMPLE_APP_PATH = path.join(__dirname, '..', '..', 'sample-app', 'index.html');
const CHECK_FOR_UPDATE_PATH = path.join(__dirname, '..', '..', 'bootstrap', 'check-for-update.js');

/**
 * Real handler for an incoming 'update-now' admin command: runs the same
 * checker a normal boot does (so it's a no-op if nothing's actually
 * changed), then exits — the Task Scheduler/Startup-folder supervisor
 * relaunches through boot-launcher.js, which resolves `current` fresh, so
 * an update installed here takes effect immediately rather than waiting
 * for the next reboot. Overridden in tests so a unit test never actually
 * exits the test process or shells out to git.
 */
function defaultRunUpdateAndExit() {
  spawnSync(process.execPath, [CHECK_FOR_UPDATE_PATH], { stdio: 'inherit' });
  process.exit(0);
}

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

function startServer({
  port = HTTP_DEFAULT_PORT,
  stateRoot,
  channel,
  announceIntervalMs = 30_000,
  adminPollIntervalMs = 10_000,
  runUpdateAndExit = defaultRunUpdateAndExit,
} = {}) {
  const { toolSet } = createContext({ stateRoot, channel });

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

  // Lets another peer trigger 'Update server now' from the sample app's
  // peer-icon context menu (channel.send) instead of waiting for this
  // instance's own next-boot check. sinceSeq is in-memory only — fine for
  // a live-running process; nothing here needs to survive a restart since
  // a restart is exactly what a successful update does anyway.
  let adminSinceSeq = 0;
  const pollAdminCommands = () => {
    toolSet.invoke('channel', { action: 'receive', sinceSeq: adminSinceSeq }).then(({ result }) => {
      for (const msg of result.messages) {
        adminSinceSeq = Math.max(adminSinceSeq, msg.seq);
        if (msg.type === 'admin-command' && msg.payload && msg.payload.command === 'update-now') {
          console.log('[admin-command] update-now received — checking for updates...');
          runUpdateAndExit();
        }
      }
    }).catch((err) => {
      console.error('admin-command poll failed:', err.message);
    });
  };
  pollAdminCommands();
  const adminPollInterval = setInterval(pollAdminCommands, adminPollIntervalMs);

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

  server.on('close', () => {
    clearInterval(announceInterval);
    clearInterval(adminPollInterval);
  });
  server.listen(port, '127.0.0.1');
  return server;
}

if (require.main === module) {
  const port = Number(process.env.OWM_HTTP_PORT) || HTTP_DEFAULT_PORT;

  // Testing aid only: OWM_CHANNEL_BACKEND=file shares presence/messages
  // across separate local processes via one JSON file on disk, so
  // multiple locally-launched instances can genuinely discover each other
  // without provisioning real Google Sheets credentials for
  // GoogleSheetsChannel (the actual cross-machine production backend).
  // Unset by default — a real launch still gets the normal private,
  // per-process InMemoryChannel.
  let channel;
  if (process.env.OWM_CHANNEL_BACKEND === 'file') {
    const { FileChannel } = require('../core/FileChannel');
    channel = new FileChannel();
    console.log(`Using shared file channel for local peer testing: ${channel.filePath}`);
  }

  const server = startServer({ port, channel });
  server.on('listening', () => {
    console.log(`OWM local HTTP server listening on http://127.0.0.1:${port}`);
  });
}

module.exports = { startServer };
