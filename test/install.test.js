'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { verifyCommitSignatureAgainst, TRUSTED_SIGNER_PRINCIPAL, TRUSTED_SIGNER_PUBLIC_KEY } = require('../bootstrap/install');

const PRINCIPAL = 'test@example.com';

/**
 * These tests prove the commit-signature-verification logic itself works,
 * by shelling out to real git/ssh-keygen — a genuine dependency for CI/dev
 * machines, but not something end users installing OWM Drive should be
 * blocked by. bootstrap/first-run.ps1 now installs git alongside Node.js,
 * but skip gracefully here rather than failing the whole self-check (and
 * therefore the whole install) on a machine where that hasn't happened yet
 * for some reason — regression: a real end user's install was refused
 * entirely because her fresh machine had no git installed, even though the
 * actual OWM Drive application code was completely fine.
 */
function hasCommand(cmd) {
  // spawnSync (not execFileSync) deliberately: ssh-keygen has no
  // --version-style flag at all and always exits non-zero for any
  // invocation like this, which a try/catch around execFileSync can't
  // distinguish from "the executable itself doesn't exist." spawnSync
  // never throws — result.error is only set when the executable itself
  // couldn't be spawned (e.g. ENOENT), which is the only thing we
  // actually care about here.
  const result = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !result.error;
}
const skipReason = !hasCommand('git')
  ? 'git is not installed on this machine'
  : !hasCommand('ssh-keygen')
    ? 'ssh-keygen is not installed on this machine'
    : false;

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Generates a throwaway ed25519 keypair for a test — never touches the real machine's own key. */
function generateThrowawayKey() {
  const dir = tempDir('owm-install-test-key-');
  const keyPath = path.join(dir, 'id_ed25519');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q']);
  const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ');
  return { keyPath: `${keyPath}.pub`, publicKey };
}

/** A throwaway local repo with one commit, signed with `signWith` (or left unsigned if omitted). */
function makeRepoWithCommit({ signWith } = {}) {
  const repoDir = tempDir('owm-install-test-repo-');
  const run = (args) => execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' });
  run(['init', '-q']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'user.email', PRINCIPAL]);
  fs.writeFileSync(path.join(repoDir, 'file.txt'), 'hello');
  run(['add', 'file.txt']);

  if (signWith) {
    run(['config', 'gpg.format', 'ssh']);
    run(['config', 'user.signingkey', signWith.keyPath]);
    run(['commit', '-q', '-S', '-m', 'signed commit']);
  } else {
    run(['commit', '-q', '--no-gpg-sign', '-m', 'unsigned commit']);
  }
  return repoDir;
}

test('verifyCommitSignatureAgainst accepts a commit signed by exactly the expected key', { skip: skipReason }, () => {
  const key = generateThrowawayKey();
  const repoDir = makeRepoWithCommit({ signWith: key });
  assert.strictEqual(verifyCommitSignatureAgainst(repoDir, { principal: PRINCIPAL, publicKey: key.publicKey }), true);
});

test('verifyCommitSignatureAgainst rejects an unsigned commit', { skip: skipReason }, () => {
  const repoDir = makeRepoWithCommit();
  const key = generateThrowawayKey();
  assert.strictEqual(verifyCommitSignatureAgainst(repoDir, { principal: PRINCIPAL, publicKey: key.publicKey }), false);
});

test('verifyCommitSignatureAgainst rejects a commit signed by a different key than the one trusted (regression: must check a SPECIFIC key, not "any valid signature")', { skip: skipReason }, () => {
  const signingKey = generateThrowawayKey();
  const differentTrustedKey = generateThrowawayKey();
  const repoDir = makeRepoWithCommit({ signWith: signingKey });
  assert.strictEqual(verifyCommitSignatureAgainst(repoDir, { principal: PRINCIPAL, publicKey: differentTrustedKey.publicKey }), false);
});

test('the pinned TRUSTED_SIGNER_* constants are well-formed (a real principal + a real ssh-ed25519 public key)', () => {
  assert.match(TRUSTED_SIGNER_PRINCIPAL, /^[^@]+@[^@]+$/);
  assert.match(TRUSTED_SIGNER_PUBLIC_KEY, /^ssh-ed25519 [A-Za-z0-9+/]+=*$/);
});
