#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const paths = require('../src/core/paths');

/**
 * Local blue-green installer: pulls candidate code into a throwaway
 * staging copy, installs deps and runs the FULL test suite there against
 * an isolated local port, and only ever promotes staging to the live
 * "current" install if every test passes. A failing candidate never
 * touches the running install — `current` keeps pointing at the last
 * version that proved itself.
 *
 * Usage:
 *   node bootstrap/install.js <git-url-or-local-path> [branch]
 */

function log(msg) {
  console.log(`[owm-install] ${msg}`);
}

function isGitUrl(source) {
  return /^(git@|https:\/\/|git:\/\/|ssh:\/\/)/.test(source) || source.endsWith('.git');
}

// npm.cmd (and any .cmd/.bat) can't be spawned directly on Windows without
// going through a shell (Node throws EINVAL otherwise). shell:true is safe
// here specifically because every arg passed through runOrThrow is a
// static internal literal, never untrusted/external input.
function runOrThrow(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) {
    throw new Error(`"${cmd} ${args.join(' ')}" failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`"${cmd} ${args.join(' ')}" exited with status ${result.status}`);
  }
}

function stageFromGit(source, ref, stagingDir) {
  log(`cloning ${source}#${ref} -> ${stagingDir}`);
  execFileSync('git', ['clone', '--branch', ref, '--depth', '1', source, stagingDir], { stdio: 'inherit' });
}

function stageFromLocalCopy(source, stagingDir) {
  log(`copying ${source} -> ${stagingDir}`);
  fs.cpSync(source, stagingDir, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src),
  });
}

/** Runs install + the full test suite in staging, on an isolated port. Returns true iff every test passed. */
function validateStaging(stagingDir, testPort) {
  log('installing dependencies in staging copy');
  runOrThrow('npm', ['install', '--omit=dev'], stagingDir);

  log(`running test suite in staging copy (OWM_TEST_PORT=${testPort}, isolated from any live install)`);
  const result = spawnSync('npm', ['test'], {
    cwd: stagingDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, OWM_TEST_PORT: String(testPort) },
  });
  return result.status === 0;
}

function readStagedVersion(stagingDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(stagingDir, 'package.json'), 'utf8'));
  return pkg.version;
}

/** Promotes a validated staging dir to a versioned slot, then atomically repoints `current`. */
function promote(stagingDir, versionLabel) {
  fs.mkdirSync(paths.VERSIONS_DIR, { recursive: true });
  const versionDir = path.join(paths.VERSIONS_DIR, versionLabel);
  if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true });
  fs.renameSync(stagingDir, versionDir);

  // Build the new link next to the old one, then swap — avoids ever
  // leaving `current` pointing at nothing partway through. Windows needs
  // a junction (works without admin rights, unlike a real symlink); the
  // 'junction' type is Windows-only, so POSIX (Mac) uses a plain
  // directory symlink instead.
  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
  const pendingLink = `${paths.CURRENT_LINK}.new`;
  if (fs.existsSync(pendingLink)) fs.rmSync(pendingLink, { recursive: true, force: true });
  fs.symlinkSync(versionDir, pendingLink, symlinkType);
  fs.rmSync(paths.CURRENT_LINK, { recursive: true, force: true });
  fs.renameSync(pendingLink, paths.CURRENT_LINK);

  log(`promoted ${versionDir} -> ${paths.CURRENT_LINK}`);
}

function main() {
  const [source, ref = 'main'] = process.argv.slice(2);
  if (!source) {
    console.error('Usage: node bootstrap/install.js <git-url-or-local-path> [branch]');
    process.exitCode = 1;
    return;
  }

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owm-staging-'));
  const testPort = 39500 + Math.floor(Math.random() * 500);

  try {
    if (isGitUrl(source)) {
      stageFromGit(source, ref, stagingDir);
    } else {
      stageFromLocalCopy(source, stagingDir);
    }

    const passed = validateStaging(stagingDir, testPort);
    if (!passed) {
      log('staging tests FAILED. Live install (if any) left untouched.');
      process.exitCode = 1;
      return;
    }

    const versionLabel = `${readStagedVersion(stagingDir)}-${Date.now()}`;
    promote(stagingDir, versionLabel);
    log('install/update succeeded.');
  } finally {
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }
}

main();
