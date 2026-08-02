'use strict';

const { fetchSecret, addSecretVersion } = require('./googleSecretManager');

/**
 * Wraps a local SecretStore with an optional cloud fallback so a value
 * set on one node - e.g. the one shared Dropbox account's refresh token,
 * obtained via whichever node first runs the one-time consent flow - is
 * discoverable by every other node without ever touching git or a manual
 * copy step. Only secrets explicitly read/written through getShared /
 * setShared ever leave this machine; plain secretStore.get/set calls stay
 * local-only exactly as before.
 */
class SharedSecretStore {
  constructor({ secretStore, secretManagerClient }) {
    this.secretStore = secretStore;
    this.secretManagerClient = secretManagerClient;
  }

  async getShared(name) {
    const local = this.secretStore.get(name);
    if (local) return local;

    const remote = await this.secretManagerClient.get(name);
    if (remote) this.secretStore.set(name, remote);
    return remote;
  }

  async setShared(name, value) {
    this.secretStore.set(name, value);
    await this.secretManagerClient.set(name, value);
  }
}

function createGoogleSecretManagerClient({ secretStore, projectId }) {
  return {
    get: (name) => fetchSecret({ secretStore, projectId, name }),
    set: (name, value) => addSecretVersion({ secretStore, projectId, name, value }),
  };
}

module.exports = { SharedSecretStore, createGoogleSecretManagerClient };
