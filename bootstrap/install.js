#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
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
  console.log(`[${new Date().toISOString()}] [owm-install] ${msg}`);
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
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: stagingDir, encoding: 'utf8' }).trim();
}

// Pinned here — in the OLD, currently-installed copy of this file, not
// something read from the newly-cloned candidate — deliberately, so a
// malicious commit can never just ship a replacement trusted key alongside
// itself and pass its own weakened check. Only this exact key is ever
// trusted, regardless of what the candidate commit's own tree claims.
const TRUSTED_SIGNER_PRINCIPAL = 'seth@oneworldmontessori.org';
const TRUSTED_SIGNER_PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCHUBSllAcHlsFch8cBLoMP7x4pK+y6iD+JOAO45+Ap';

/**
 * True iff stagingDir's HEAD commit carries a valid SSH signature from
 * exactly the given principal+publicKey — factored out from
 * verifyCommitSignature() below so it's unit-testable against arbitrary
 * generated keys, not just whatever real key happens to be on this machine.
 */
function verifyCommitSignatureAgainst(stagingDir, { principal, publicKey }) {
  const allowedSignersPath = path.join(os.tmpdir(), `owm-allowed-signers-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(allowedSignersPath, `${principal} ${publicKey}\n`);
  try {
    execFileSync('git', ['-c', `gpg.ssh.allowedSignersFile=${allowedSignersPath}`, 'verify-commit', 'HEAD'], {
      cwd: stagingDir,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(allowedSignersPath, { force: true });
  }
}

/** True iff the staged git repo's HEAD commit carries a valid SSH signature from the one pinned trusted key. */
function verifyCommitSignature(stagingDir) {
  return verifyCommitSignatureAgainst(stagingDir, { principal: TRUSTED_SIGNER_PRINCIPAL, publicKey: TRUSTED_SIGNER_PUBLIC_KEY });
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
function promote(stagingDir, versionLabel, meta = {}) {
  fs.mkdirSync(paths.VERSIONS_DIR, { recursive: true });
  const versionDir = path.join(paths.VERSIONS_DIR, versionLabel);
  if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true });
  fs.renameSync(stagingDir, versionDir);

  // Records which git commit is actually live, so check-for-update.js can
  // tell whether `main` has moved on without re-cloning just to find out.
  fs.writeFileSync(
    path.join(versionDir, '.owm-install-meta.json'),
    JSON.stringify({ commit: meta.commit ?? null, installedAt: new Date().toISOString() }),
  );

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
    let commit = null;
    if (isGitUrl(source)) {
      commit = stageFromGit(source, ref, stagingDir);

      // Checked before any dependency install or test run — an untrusted
      // commit never even gets that far, let alone a chance to run its own
      // (possibly tampered) code.
      if (!verifyCommitSignature(stagingDir)) {
        log(`commit ${commit} is not signed by the trusted key (${TRUSTED_SIGNER_PRINCIPAL}) — refusing to install. Live install (if any) left untouched.`);
        process.exitCode = 1;
        return;
      }
      log(`commit ${commit} signature verified.`);
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
    promote(stagingDir, versionLabel, { commit });
    log('install/update succeeded.');
  } finally {
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { verifyCommitSignatureAgainst, verifyCommitSignature, TRUSTED_SIGNER_PRINCIPAL, TRUSTED_SIGNER_PUBLIC_KEY };
