'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { exec } = require('node:child_process');
const { google } = require('googleapis');
const DEFAULT_CLIENT_JSON = require('./default-google-oauth-client.json');

// Upgraded from drive.readonly to full drive access — createFolder/move
// need write, and Drive has no narrower scope that covers "move any
// pre-existing file" (drive.file only covers files the app itself
// created/opened). Still per-user OAuth, not domain-wide delegation —
// this authorizes what the signed-in account can already do to their own
// Drive, nothing broader.
const SCOPES = ['https://www.googleapis.com/auth/drive'];

/**
 * Lazily produces an authenticated Drive v3 client using our own
 * Desktop-app OAuth client (created in Google Cloud Console — gcloud's
 * shared client is restricted from requesting Drive scopes as of
 * 2026-07). Both the client id/secret and the resulting refresh token
 * live only in SecretStore — never in a plaintext file, never logged.
 *
 * First run opens a browser for one-time consent via a local loopback
 * redirect (a temporary HTTP server on an OS-assigned port); every run
 * after that reuses the stored refresh token silently.
 *
 * The client id/secret ship bundled in the repo (default-google-oauth-client.json)
 * rather than requiring every install to run `drive setup` first — this is
 * safe for an "installed application" OAuth client: Google's own threat
 * model treats this secret as a public app identifier, not a confidential
 * value, since a distributed native client can never actually keep it
 * secret. Each user still does their own real consent and gets their own
 * refresh token reflecting their own Drive permissions; `setup` remains
 * available to override the bundled client if a different one is ever needed.
 */
async function getDriveClient({ secretStore }) {
  const configuredClientJson = secretStore.get('google_oauth_client');
  const clientJson = configuredClientJson ? JSON.parse(configuredClientJson) : DEFAULT_CLIENT_JSON;
  const { client_id, client_secret } = clientJson.installed;
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret);

  const refreshToken = secretStore.get('google_oauth_refresh_token');
  if (refreshToken) {
    oauth2Client.setCredentials({ refresh_token: refreshToken });
  } else {
    const tokens = await runConsentFlow(oauth2Client);
    if (!tokens.refresh_token) {
      throw new Error('Google did not return a refresh token — revoke prior access at myaccount.google.com/permissions and try again (prompt=consent should prevent this, but Google only issues a refresh token on first-ever consent for a client).');
    }
    secretStore.set('google_oauth_refresh_token', tokens.refresh_token);
    oauth2Client.setCredentials(tokens);
  }

  return google.drive({ version: 'v3', auth: oauth2Client });
}

function runConsentFlow(oauth2Client) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const code = url.searchParams.get('code');
        if (!code) return;
        res.end('Signed in to Google Drive for OWM — you can close this tab.');
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
        prompt: 'consent',
        redirect_uri: oauth2Client.redirectUri,
      });
      console.log(`Open this URL to sign in to Google Drive:\n${authUrl}`);
      const opener = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      exec(`${opener} "${authUrl}"`, () => {});
    });
  });
}

module.exports = { getDriveClient, SCOPES };
