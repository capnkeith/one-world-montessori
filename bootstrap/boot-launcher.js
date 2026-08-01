#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync, spawn } = require('child_process');
const paths = require('../src/core/paths');

// Entry point wired into auto-start (Task Scheduler / Startup-folder loop)
// in place of launching http-server.js directly. Runs the update check
// first — if it promotes a new version, `current` is a junction/symlink
// that now points elsewhere — then resolves the server path *after* that,
// so an update installed this boot is what actually launches, not last
// boot's version.
spawnSync(process.execPath, [path.join(__dirname, 'check-for-update.js')], { stdio: 'inherit' });

const serverScript = path.join(paths.CURRENT_LINK, 'src', 'server', 'http-server.js');
const child = spawn(process.execPath, [serverScript], { stdio: 'inherit' });
child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
