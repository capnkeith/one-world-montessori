'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createSecretStore } = require('./core/SecretStore');
const { SharedSecretStore, createGoogleSecretManagerClient } = require('./core/SharedSecretStore');
const { Profile } = require('./core/Profile');
const { InMemoryChannel } = require('./core/Channel');
const { buildChannelFromSecretStore } = require('./core/googleSheetsAuth');
const { InMemoryCatalogEventLog } = require('./core/CatalogEventLog');
const { FileCatalog } = require('./core/FileCatalog');
const { JobStore } = require('./core/JobStore');
const { InvoiceCounter } = require('./core/InvoiceCounter');
const { buildToolSet } = require('./tools');
const paths = require('./core/paths');

// JPEG, not PNG: pdfkit's PNG decoder renders this specific logo's colors
// wrong (confirmed by isolating it — a synthetic flat-color PNG through
// the exact same pdfkit->render pipeline came out fine, so this isn't a
// general PNG bug, just this image). JPEG embeds correctly. The
// canonical PNG (used by the sample app) is untouched; this is a
// separate flattened-to-white copy just for the PDF invoice.
const INVOICE_LOGO_PATH = path.join(__dirname, '..', 'assets', 'owm-logo.jpg');

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
 *
 * `channel` left unset (the normal case for a real launch) resolves to a
 * real GoogleSheetsChannel if this node's own `channel setup` action has
 * stored a service-account key + spreadsheetId, otherwise the private,
 * per-process InMemoryChannel — explicitly passing one (as every test
 * does) always wins over both.
 */
function createContext({ stateRoot = paths.STATE_ROOT, channel } = {}) {
  const secretStore = createSecretStore(path.join(stateRoot, 'secrets'));
  const resolvedChannel = channel ?? buildChannelFromSecretStore({ secretStore }) ?? new InMemoryChannel();
  const sharedSecretStore = new SharedSecretStore({
    secretStore,
    secretManagerClient: createGoogleSecretManagerClient({ secretStore }),
  });
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
  const jobStore = new JobStore(path.join(stateRoot, 'jobs.json'));
  const invoiceCounter = new InvoiceCounter(path.join(stateRoot, 'invoice-counter.json'));
  const invoiceLogoBuffer = fs.existsSync(INVOICE_LOGO_PATH) ? fs.readFileSync(INVOICE_LOGO_PATH) : null;

  const toolSet = buildToolSet({
    secretStore,
    sharedSecretStore,
    profile,
    channel: resolvedChannel,
    instanceId: profileData.instanceId,
    displayName: profileData.displayName,
    catalog,
    catalogEventLog,
    persistCatalogSnapshot,
    jobStore,
    invoiceCounter,
    invoiceLogoBuffer,
  });

  return { secretStore, sharedSecretStore, profile, toolSet, channel: resolvedChannel, catalog, jobStore, stateRoot, instanceId: profileData.instanceId };
}

module.exports = { createContext };
