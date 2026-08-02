'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { exec } = require('node:child_process');

const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

/**
 * Dropbox OAuth2 with PKCE (no client secret needed — Dropbox's
 * "public client" flow for installed/desktop apps). Only the app key
 * and the resulting refresh token live in SecretStore; the app key
 * identifies the application (safe to distribute to every install,
 * same reasoning as Drive's Desktop OAuth client), the refresh token
 * is per-user and never shared.
 */
async function getDropboxClient({ secretStore, sharedSecretStore }) {
  const appKey = secretStore.get('dropbox_app_key');
  if (!appKey) {
    throw new Error(
      'No Dropbox app configured. Run: node src/cli.js call dropbox \'{"action":"setup","appKey":"<your App key>"}\''
    );
  }

  let refreshToken = secretStore.get('dropbox_refresh_token');

  // This is one shared Dropbox account across every node - before running
  // our own interactive consent, check whether some other node already
  // completed it and published the resulting token via Secret Manager.
  if (!refreshToken && sharedSecretStore) {
    refreshToken = await sharedSecretStore.getShared('dropbox_refresh_token');
  }

  if (!refreshToken) {
    if (!process.stdout.isTTY) {
      throw new Error(
        'No cached Dropbox credentials (checked locally and, if configured, Secret Manager), and this process ' +
          'has no interactive terminal to open a consent browser from — refusing to try (a background/service ' +
          'process silently popping browser windows is exactly what caused the 2026-08-01 incident). Run ' +
          '`node src/cli.js call dropbox \'{"action":"browse"}\'` from a real terminal once to authorize this ' +
          'machine, then background processes will reuse the cached token.'
      );
    }
    refreshToken = await runConsentFlow(appKey);
    secretStore.set('dropbox_refresh_token', refreshToken);
    if (sharedSecretStore) await sharedSecretStore.setShared('dropbox_refresh_token', refreshToken);
  }

  return {
    async call(path, body) {
      const accessToken = await getAccessToken(appKey, refreshToken);
      const res = await fetch(`https://api.dropboxapi.com/2/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) throw new Error(`Dropbox API ${path} failed: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async download(path) {
      const accessToken = await getAccessToken(appKey, refreshToken);
      const res = await fetch('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Dropbox-API-Arg': JSON.stringify({ path }) },
      });
      if (!res.ok) throw new Error(`Dropbox download failed: ${res.status} ${await res.text()}`);
      return res.text();
    },
  };
}

async function getAccessToken(appKey, refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: appKey }),
  });
  if (!res.ok) throw new Error(`Dropbox token refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function runConsentFlow(appKey) {
  return new Promise((resolve, reject) => {
    const codeVerifier = base64url(crypto.randomBytes(32));
    const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const code = url.searchParams.get('code');
        if (!code) return;
        res.end('Signed in to Dropbox for OWM — you can close this tab.');
        server.close();

        const tokenRes = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            grant_type: 'authorization_code',
            client_id: appKey,
            code_verifier: codeVerifier,
            redirect_uri: server._redirectUri,
          }),
        });
        if (!tokenRes.ok) throw new Error(`Dropbox token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
        const tokens = await tokenRes.json();
        if (!tokens.refresh_token) throw new Error('Dropbox did not return a refresh token.');
        resolve(tokens.refresh_token);
      } catch (err) {
        reject(err);
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server._redirectUri = `http://localhost:${port}`;
      const authUrl = new URL(AUTHORIZE_URL);
      authUrl.searchParams.set('client_id', appKey);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('redirect_uri', server._redirectUri);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('token_access_type', 'offline');

      console.log(`Open this URL to sign in to Dropbox:\n${authUrl.toString()}`);
      const opener = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      exec(`${opener} "${authUrl.toString()}"`, () => {});
    });
  });
}

module.exports = { getDropboxClient };
