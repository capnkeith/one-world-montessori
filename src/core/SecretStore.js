'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

/**
 * Shared interface across all backends: get/set/has/delete/list.
 * Values are never exposed by has()/list() — only presence booleans and
 * key names. createSecretStore() picks a platform-appropriate backend
 * automatically; nothing else in the codebase should construct a backend
 * class directly.
 */

/**
 * Windows backend: each value is protected via Windows DPAPI
 * (System.Security.Cryptography.ProtectedData, CurrentUser scope),
 * invoked through a short-lived PowerShell child process per call. This
 * ties decryption to the specific Windows user profile — the same
 * mechanism Windows Credential Manager itself relies on — with no
 * native Node module / node-gyp build required.
 */
class WindowsDpapiSecretStore {
  constructor(storeDir) {
    this.storeDir = storeDir;
    this.dataPath = path.join(storeDir, 'secrets.dpapi.json');
  }

  _load() {
    if (!fs.existsSync(this.dataPath)) return {};
    return JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));
  }

  _save(all) {
    fs.mkdirSync(this.storeDir, { recursive: true });
    fs.writeFileSync(this.dataPath, JSON.stringify(all, null, 2));
  }

  _runDpapi(script, envVars) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, ...envVars },
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`DPAPI operation failed: ${result.stderr || result.error?.message}`);
    }
    return result.stdout.trim();
  }

  _protect(plainText) {
    const script = `
      Add-Type -AssemblyName System.Security
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($env:OWM_SECRET_INPUT)
      $protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Convert]::ToBase64String($protected)
    `;
    return this._runDpapi(script, { OWM_SECRET_INPUT: plainText });
  }

  _unprotect(base64Cipher) {
    const script = `
      Add-Type -AssemblyName System.Security
      $bytes = [Convert]::FromBase64String($env:OWM_SECRET_CIPHER)
      $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      [System.Text.Encoding]::UTF8.GetString($plain)
    `;
    return this._runDpapi(script, { OWM_SECRET_CIPHER: base64Cipher });
  }

  set(name, value) {
    const all = this._load();
    all[name] = this._protect(String(value));
    this._save(all);
  }

  get(name) {
    const all = this._load();
    if (!(name in all)) return null;
    return this._unprotect(all[name]);
  }

  has(name) {
    return name in this._load();
  }

  delete(name) {
    const all = this._load();
    delete all[name];
    this._save(all);
  }

  list() {
    return Object.keys(this._load());
  }
}

/**
 * macOS backend: values live in the login Keychain via the `security`
 * CLI (present by default on macOS). A small local index file tracks
 * key *names* only (never values) so list() doesn't need a Keychain
 * enumeration call.
 */
class MacKeychainSecretStore {
  constructor(storeDir, service = 'owm-mcp') {
    this.storeDir = storeDir;
    this.service = service;
    this.indexPath = path.join(storeDir, 'secret-keys.json');
  }

  _index() {
    if (!fs.existsSync(this.indexPath)) return [];
    return JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
  }

  _saveIndex(keys) {
    fs.mkdirSync(this.storeDir, { recursive: true });
    fs.writeFileSync(this.indexPath, JSON.stringify(keys, null, 2));
  }

  set(name, value) {
    // -U updates in place if the entry already exists.
    spawnSync('security', ['add-generic-password', '-a', name, '-s', this.service, '-w', String(value), '-U'], {
      encoding: 'utf8',
    });
    const keys = new Set(this._index());
    keys.add(name);
    this._saveIndex([...keys]);
  }

  get(name) {
    const result = spawnSync('security', ['find-generic-password', '-a', name, '-s', this.service, '-w'], {
      encoding: 'utf8',
    });
    if (result.status !== 0) return null;
    return result.stdout.replace(/\n$/, '');
  }

  has(name) {
    return this._index().includes(name);
  }

  delete(name) {
    spawnSync('security', ['delete-generic-password', '-a', name, '-s', this.service], { encoding: 'utf8' });
    this._saveIndex(this._index().filter((k) => k !== name));
  }

  list() {
    return this._index();
  }
}

/**
 * Fallback backend for platforms with no OS credential vault wired up
 * yet (e.g. Linux). Encrypted at rest with a locally-generated AES-256
 * key file (restrictive permissions) rather than a real OS keyring —
 * genuinely a stand-in, not a production-grade secret store. Wire up a
 * libsecret-backed implementation behind this same interface before
 * Linux carries real credentials.
 */
class FileSecretStore {
  constructor(storeDir) {
    this.storeDir = storeDir;
    this.dataPath = path.join(storeDir, 'secrets.enc');
    this.keyPath = path.join(storeDir, '.secret-key');
  }

  _ensureKey() {
    fs.mkdirSync(this.storeDir, { recursive: true });
    if (!fs.existsSync(this.keyPath)) {
      fs.writeFileSync(this.keyPath, crypto.randomBytes(32), { mode: 0o600 });
    }
    return fs.readFileSync(this.keyPath);
  }

  _load() {
    if (!fs.existsSync(this.dataPath)) return {};
    const key = this._ensureKey();
    const raw = fs.readFileSync(this.dataPath);
    const iv = raw.subarray(0, 16);
    const encrypted = raw.subarray(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  }

  _save(all) {
    const key = this._ensureKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(all), 'utf8'), cipher.final()]);
    fs.mkdirSync(this.storeDir, { recursive: true });
    fs.writeFileSync(this.dataPath, Buffer.concat([iv, encrypted]), { mode: 0o600 });
  }

  set(name, value) {
    const all = this._load();
    all[name] = value;
    this._save(all);
  }

  get(name) {
    return this._load()[name] ?? null;
  }

  has(name) {
    return this.get(name) !== null;
  }

  delete(name) {
    const all = this._load();
    delete all[name];
    this._save(all);
  }

  list() {
    return Object.keys(this._load());
  }
}

function createSecretStore(storeDir) {
  if (process.platform === 'win32') return new WindowsDpapiSecretStore(storeDir);
  if (process.platform === 'darwin') return new MacKeychainSecretStore(storeDir);
  return new FileSecretStore(storeDir);
}

module.exports = {
  createSecretStore,
  WindowsDpapiSecretStore,
  MacKeychainSecretStore,
  FileSecretStore,
};
