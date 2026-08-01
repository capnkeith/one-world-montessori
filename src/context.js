'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createSecretStore } = require('./core/SecretStore');
const { Profile } = require('./core/Profile');
const { InMemoryChannel } = require('./core/Channel');
const { InMemoryCatalogEventLog } = require('./core/CatalogEventLog');
const { FileCatalog } = require('./core/FileCatalog');
const { buildToolSet } = require('./tools');
const paths = require('./core/paths');

/**
 * Constructs the shared runtime context (secretStore, profile, toolSet)
 * that every front end wires up identically. `stateRoot` is overridable
 * so tests and the bootstrap installer's staging copy don't collide with
 * a real local install. `channel` is overridable so tests can put
 * multiple in-process contexts on the same InMemoryChannel to exercise
 * peer discovery/messaging without any real backend.
 *
 * The catalog's event log is only durable within one process (see
 * CatalogEventLog.js) — what persists ACROSS process runs is the merged
 * FileCatalog snapshot, saved to disk after every mutation. That's
 * enough for a single-machine, single-active-writer setup; real
 * multi-machine sync is the deferred Firestore/Sheets backend work.
 */
function createContext({ stateRoot = paths.STATE_ROOT, channel = new InMemoryChannel() } = {}) {
  const secretStore = createSecretStore(path.join(stateRoot, 'secrets'));
  const profile = new Profile(path.join(stateRoot, 'profile.json'));

  let profileData = profile.load();
  if (!profileData.instanceId) {
    profileData = profile.update({
      instanceId: crypto.randomUUID(),
      displayName: profileData.displayName ?? os.hostname(),
    });
  }

  const catalogSnapshotPath = path.join(stateRoot, 'catalog-snapshot.json');
  const catalog = fs.existsSync(catalogSnapshotPath)
    ? FileCatalog.fromSnapshot(JSON.parse(fs.readFileSync(catalogSnapshotPath, 'utf8')))
    : new FileCatalog();
  const persistCatalogSnapshot = () => {
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(catalogSnapshotPath, JSON.stringify(catalog.snapshot()));
  };
  const catalogEventLog = new InMemoryCatalogEventLog({ startSeq: catalog.lastSeq });

  const toolSet = buildToolSet({
    secretStore,
    profile,
    channel,
    instanceId: profileData.instanceId,
    displayName: profileData.displayName,
    catalog,
    catalogEventLog,
    persistCatalogSnapshot,
  });

  return { secretStore, profile, toolSet, channel, catalog, stateRoot, instanceId: profileData.instanceId };
}

module.exports = { createContext };
