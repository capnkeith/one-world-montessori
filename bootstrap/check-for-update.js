#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const paths = require('../src/core/paths');

/**
 * Runs at every boot (wired in via bootstrap/boot-launcher.js) to keep an
 * install current without anyone manually re-running the installer. Cheap
 * on the common case: a `git ls-remote` to learn main's HEAD commit is one
 * round-trip with no clone, so "already up to date" (the vast majority of
 * boots) costs almost nothing. Only a real difference triggers the full
 * blue-green install.js pipeline, which already refuses to touch the live
 * install if the candidate fails its own tests.
 */

const REPO_URL = 'https://github.com/capnkeith/one-world-montessori.git';
const BRANCH = 'main';

function log(msg) {
  console.log(`[owm-update-check] ${msg}`);
}

function readInstalledCommit() {
  const metaPath = path.join(paths.CURRENT_LINK, '.owm-install-meta.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')).commit ?? null;
  } catch {
    return null;
  }
}

function fetchRemoteCommit() {
  const output = execFileSync('git', ['ls-remote', REPO_URL, `refs/heads/${BRANCH}`], { encoding: 'utf8' });
  const sha = output.split(/\s+/)[0];
  if (!sha) throw new Error(`could not determine remote HEAD for ${BRANCH}`);
  return sha;
}

function runInstall() {
  const installerPath = path.join(__dirname, 'install.js');
  const result = spawnSync(process.execPath, [installerPath, REPO_URL, BRANCH], { stdio: 'inherit' });
  return result.status === 0;
}

// Every side effect is injected so this is testable without a real network
// call, git binary, or install run — real implementations are wired in the
// require.main block below.
function checkForUpdate({ readInstalledCommit: readInstalled, fetchRemoteCommit: fetchRemote, runInstall: install, log: doLog }) {
  let remoteCommit;
  try {
    remoteCommit = fetchRemote();
  } catch (err) {
    doLog(`could not reach GitHub, skipping update check: ${err.message}`);
    return { updated: false, reason: 'unreachable' };
  }

  const installedCommit = readInstalled();
  if (installedCommit === remoteCommit) {
    doLog('already up to date.');
    return { updated: false, reason: 'up-to-date', commit: installedCommit };
  }

  doLog(`update available (installed=${installedCommit ?? 'unknown'}, remote=${remoteCommit}) — installing...`);
  const success = install();
  doLog(success ? 'update installed successfully.' : 'update install failed — leaving previous install in place.');
  return { updated: success, reason: success ? 'installed' : 'install-failed', commit: remoteCommit };
}

if (require.main === module) {
  const result = checkForUpdate({ readInstalledCommit, fetchRemoteCommit, runInstall, log });
  if (result.reason === 'install-failed') process.exitCode = 1;
}

module.exports = { checkForUpdate, readInstalledCommit, fetchRemoteCommit, runInstall };
