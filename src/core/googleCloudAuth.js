'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { exec } = require('node:child_process');
const { google } = require('googleapis');
const DEFAULT_CLIENT_JSON = require('./default-google-oauth-client.json');
const { isInteractiveConsentAllowed } = require('./interactiveConsent');

// Both Secret Manager and Firestore only support the broad `cloud-platform`
// scope for user credentials (no narrower one exists for either) - kept
// under its own refresh token (`google_secrets_refresh_token`), separate
// from Drive's `drive`-scoped one and Gmail's, so a leaked/compromised
// token for one purpose can't reach the others. IAM (bound per-resource
// when each secret/database is created, not here) is what actually keeps
// this narrow: this scope only grants what the signed-in account's own
// IAM role allows.
const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

/**
 * Same per-user OAuth shape as googleAuth.js's getDriveClient (bundled
 * installed-app client id/secret, per-user consent, refresh token cached
 * in SecretStore) — see that file's header for the full reasoning.
 *
 * A consent flow only ever runs when the caller passes `allowConsent:
 * true` — never as a side effect of an ordinary read/write like
 * fetchSecret/addSecretVersion. See gmailAuth.js's header for the
 * 2026-08-02 incident this mirrors. `fetchSecret` (googleSecretManager.js)
 * treats the resulting GOOGLE_AUTH_REQUIRED error the same as "secret
 * doesn't exist yet" — so an unauthorized node's plain reads (e.g.
 * dropboxAuth.js checking whether another node already published a
 * shared token) degrade to "nothing shared" instead of throwing.
 */
async function getCloudPlatformAuth({ secretStore, allowConsent = false }) {
  const configuredClientJson = secretStore.get('google_oauth_client');
  const clientJson = configuredClientJson ? JSON.parse(configuredClientJson) : DEFAULT_CLIENT_JSON;
  const { client_id, client_secret } = clientJson.installed;
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret);

  const refreshToken = secretStore.get('google_secrets_refresh_token');
  if (refreshToken) {
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return oauth2Client;
  }

  if (!allowConsent) {
    const err = new Error(
      'No cached cloud-platform credentials. A consent flow never starts as a side effect of another action ' +
        '(see the 2026-08-02 out-of-place-consent-prompt note in TODO.md) — authorize it explicitly first.'
    );
    err.code = 'GOOGLE_AUTH_REQUIRED';
    throw err;
  }

  if (!isInteractiveConsentAllowed()) {
    throw new Error(
      'Authorizing shared cloud-platform access needs a real interactive terminal to open a consent browser ' +
        'from, and this process has none — refusing to try (see the 2026-08-01 runaway-browser incident notes ' +
        'in TODO.md).'
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
        res.end('Signed in to Google (shared cloud-platform access) for OWM — you can close this tab.');
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
      console.log(`Open this URL to authorize shared cloud-platform access:\n${authUrl}`);
      const opener = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      exec(`${opener} "${authUrl}"`, () => {});
    });
  });
}

module.exports = { getCloudPlatformAuth };
