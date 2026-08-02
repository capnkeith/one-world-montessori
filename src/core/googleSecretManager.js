'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { exec } = require('node:child_process');
const { google } = require('googleapis');
const DEFAULT_CLIENT_JSON = require('./default-google-oauth-client.json');

const DEFAULT_PROJECT_ID = 'owm-drive-browser';

// Secret Manager only supports the broad `cloud-platform` scope for user
// credentials (no narrower one exists) - kept under its own refresh token
// (`google_secrets_refresh_token`), separate from Drive's `drive`-scoped
// one, so a leaked/compromised token for one purpose can't reach the
// other. IAM (bound per-secret when each secret is created, not here)
// is what actually keeps this narrow: this scope only grants what the
// signed-in account's own IAM role allows.
const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

/**
 * Same per-user OAuth shape as googleAuth.js's getDriveClient (bundled
 * installed-app client id/secret, per-user consent, refresh token cached
 * in SecretStore) - see that file's header for the full reasoning. Also
 * carries the same interactive-terminal guard added after the
 * 2026-08-01 incident: a background process must never be able to pop a
 * real browser window on its own.
 */
async function getSecretManagerAuth({ secretStore }) {
  const configuredClientJson = secretStore.get('google_oauth_client');
  const clientJson = configuredClientJson ? JSON.parse(configuredClientJson) : DEFAULT_CLIENT_JSON;
  const { client_id, client_secret } = clientJson.installed;
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret);

  const refreshToken = secretStore.get('google_secrets_refresh_token');
  if (refreshToken) {
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return oauth2Client;
  }

  if (!process.stdout.isTTY) {
    throw new Error(
      'No cached Secret Manager credentials, and this process has no interactive terminal to open a consent ' +
        'browser from — refusing to try (see the 2026-08-01 runaway-browser incident notes in TODO.md). Run ' +
        '`node src/cli.js call dropbox \'{"action":"browse"}\'` from a real terminal once to authorize this ' +
        'machine for shared-secret access.'
    );
  }
  const tokens = await runConsentFlow(oauth2Client);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token — revoke prior access at myaccount.google.com/permissions and try again.'
    );
  }
  secretStore.set('google_secrets_refresh_token', tokens.refresh_token);
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

function runConsentFlow(oauth2Client) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const code = url.searchParams.get('code');
        if (!code) return;
        res.end('Signed in to Google (shared secrets access) for OWM — you can close this tab.');
        server.close();
        const { tokens } = await oauth2Client.getToken({ code, redirect_uri: oauth2Client.redirectUri });
        resolve(tokens);
      } catch (err) {
        reject(err);
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      oauth2Client.redirectUri = `http://localhost:${port}`;
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'select_account consent',
        redirect_uri: oauth2Client.redirectUri,
      });
      console.log(`Open this URL to authorize shared-secret access:\n${authUrl}`);
      const opener = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      exec(`${opener} "${authUrl}"`, () => {});
    });
  });
}

/**
 * Reads the latest version of a Secret Manager secret. Returns null
 * (rather than throwing) when the secret exists but has no version yet,
 * or doesn't exist at all — both mean "nothing shared yet", not an error.
 */
async function fetchSecret({ secretStore, projectId = DEFAULT_PROJECT_ID, name, fetchImpl = fetch }) {
  const auth = await getSecretManagerAuth({ secretStore });
  const { token } = await auth.getAccessToken();
  const res = await fetchImpl(
    `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${name}/versions/latest:access`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Secret Manager access failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return Buffer.from(data.payload.data, 'base64').toString('utf8');
}

/** Adds a new version to an already-existing secret container. */
async function addSecretVersion({ secretStore, projectId = DEFAULT_PROJECT_ID, name, value, fetchImpl = fetch }) {
  const auth = await getSecretManagerAuth({ secretStore });
  const { token } = await auth.getAccessToken();
  const res = await fetchImpl(`https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${name}:addVersion`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: { data: Buffer.from(value, 'utf8').toString('base64') } }),
  });
  if (!res.ok) throw new Error(`Secret Manager addVersion failed: ${res.status} ${await res.text()}`);
}

module.exports = { getSecretManagerAuth, fetchSecret, addSecretVersion, DEFAULT_PROJECT_ID };
