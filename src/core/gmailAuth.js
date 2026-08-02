'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { exec } = require('node:child_process');
const { google } = require('googleapis');
const DEFAULT_CLIENT_JSON = require('./default-google-oauth-client.json');
const { isInteractiveConsentAllowed } = require('./interactiveConsent');

// Kept under its own refresh token (`gmail_refresh_token`), separate from
// Drive's and Secret Manager's, for the same blast-radius reason as
// everywhere else in this codebase: a leaked token for one purpose
// shouldn't reach another. Whichever real Google account completes the
// one-time consent below is the account this sends/reads as — nothing
// here hardcodes an identity (still undecided as of 2026-08-01 whether
// this runs as Seth's own account or a dedicated claude@oneworldmontessori.org
// mailbox Seth is creating).
const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];

/**
 * Same per-user OAuth shape as googleAuth.js's getDriveClient (bundled
 * installed-app client id/secret, per-account consent, refresh token
 * cached in SecretStore) — see that file's header for the full
 * reasoning. Carries the same interactive-terminal guard added after
 * the 2026-08-01 incident: a background process must never be able to
 * pop a real browser window on its own.
 */
async function getGmailClient({ secretStore }) {
  const configuredClientJson = secretStore.get('google_oauth_client');
  const clientJson = configuredClientJson ? JSON.parse(configuredClientJson) : DEFAULT_CLIENT_JSON;
  const { client_id, client_secret } = clientJson.installed;
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret);

  const refreshToken = secretStore.get('gmail_refresh_token');
  if (refreshToken) {
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return google.gmail({ version: 'v1', auth: oauth2Client });
  }

  if (!isInteractiveConsentAllowed()) {
    throw new Error(
      'No cached Gmail credentials, and this process has no interactive terminal to open a consent browser ' +
        'from — refusing to try (see the 2026-08-01 runaway-browser incident notes in TODO.md). Run ' +
        '`node src/cli.js call mail \'{"action":"listMessages"}\'` from a real terminal, signed into whichever ' +
        'account this should send/read as, to authorize this machine.'
    );
  }
  const tokens = await runConsentFlow(oauth2Client);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token — revoke prior access at myaccount.google.com/permissions and try again.');
  }
  secretStore.set('gmail_refresh_token', tokens.refresh_token);
  oauth2Client.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

function runConsentFlow(oauth2Client) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const code = url.searchParams.get('code');
        if (!code) return;
        res.end('Signed in to Gmail for OWM — you can close this tab.');
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
      console.log(`Open this URL to sign in to Gmail:\n${authUrl}`);
      const opener = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      exec(`${opener} "${authUrl}"`, () => {});
    });
  });
}

module.exports = { getGmailClient, SCOPES };
