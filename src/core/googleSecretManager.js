'use strict';

const { getCloudPlatformAuth } = require('./googleCloudAuth');

const DEFAULT_PROJECT_ID = 'owm-drive-browser';

// getSecretManagerAuth used to own this OAuth flow directly; it's now
// shared with Firestore (src/core/firestoreStore.js) via
// googleCloudAuth.js, since both only support the cloud-platform scope
// for user credentials. Kept as its own export name here for backward
// compatibility with existing callers/tests.
const getSecretManagerAuth = getCloudPlatformAuth;

/**
 * Reads the latest version of a Secret Manager secret. Returns null
 * (rather than throwing) when the secret exists but has no version yet,
 * or doesn't exist at all, or this node has never authorized shared
 * cloud-platform access at all — all three mean "nothing shared yet
 * (from here)", not an error. A plain read must never be the thing that
 * makes an unauthorized node try to open a consent browser (see
 * googleCloudAuth.js's header).
 */
async function fetchSecret({ secretStore, projectId = DEFAULT_PROJECT_ID, name, fetchImpl = fetch }) {
  let auth;
  try {
    auth = await getSecretManagerAuth({ secretStore });
  } catch (err) {
    if (err.code === 'GOOGLE_AUTH_REQUIRED') return null;
    throw err;
  }
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
