'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const { z } = require('zod');
const { Tool } = require('../core/Tool');
const { getDriveClient } = require('../core/googleAuth');
const { extractText, supportsExtraction } = require('../core/textExtract');
const { supportsRichPreview, renderRichPreview } = require('../core/richPreview');

function isFolder(mimeType) {
  return mimeType === 'application/vnd.google-apps.folder';
}

/** Follows nextPageToken until exhausted — a single files.list call silently truncates at pageSize otherwise. */
async function listAllPages(client, baseParams) {
  const all = [];
  let pageToken;
  do {
    const res = await client.files.list({ ...baseParams, pageSize: 1000, pageToken });
    all.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return all;
}

/** All descendant file/folder IDs under any of `hiddenFolderIds`, so search can't surface a hidden folder's contents by name match. */
async function expandHiddenTrees(client, hiddenFolderIds) {
  const found = new Set();
  const queue = [...hiddenFolderIds];
  while (queue.length) {
    const parentId = queue.shift();
    const children = await listAllPages(client, {
      q: `'${parentId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, mimeType)',
    });
    for (const child of children) {
      if (!found.has(child.id)) {
        found.add(child.id);
        if (isFolder(child.mimeType)) queue.push(child.id);
      }
    }
  }
  return found;
}

/**
 * Drive's own files.copy only duplicates a folder as an empty shell —
 * it does not copy contents. A real "copy" of a folder (matching what a
 * normal file browser's Copy/Paste does) means recreating the folder and
 * recursively copying every descendant into it. Files copy directly via
 * the API in one call; only folders need the recursive walk.
 */
async function copyRecursive(client, id, newParentId) {
  const meta = await client.files.get({ fileId: id, fields: 'id, name, mimeType' });
  const { name, mimeType } = meta.data;

  if (!isFolder(mimeType)) {
    const res = await client.files.copy({ fileId: id, requestBody: { name, parents: [newParentId] } });
    return res.data.id;
  }

  const newFolder = await client.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [newParentId] },
    fields: 'id',
  });
  const children = await listAllPages(client, {
    q: `'${id}' in parents and trashed = false`,
    fields: 'nextPageToken, files(id)',
  });
  for (const child of children) {
    await copyRecursive(client, child.id, newFolder.data.id);
  }
  return newFolder.data.id;
}

function mapFile(f) {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    isFolder: isFolder(f.mimeType),
    size: f.size ?? null,
    md5Checksum: f.md5Checksum ?? null,
    modifiedTime: f.modifiedTime ?? null,
    webViewLink: f.webViewLink ?? null,
  };
}

const LIST_FIELDS = 'nextPageToken, files(id, name, mimeType, size, md5Checksum, modifiedTime, webViewLink)';

// The org's shared Drive tree — every install's home view opens here, not to
// whichever account happens to be signed in. 'root' (Google's own alias for
// "this account's personal My Drive") is kept as a distinct, explicit peer
// entry alongside it, reachable by browsing folderId 'root'.
const OWM_ROOT_FOLDER_ID = '14HsjBUU7L-2kk283-pg36r4NzyafdDDI';

// Minimal in-memory Profile stand-in for tests — same load/update shape as
// the real one, no disk involved.
function fakeProfile(initial = {}) {
  let state = { driveHiddenFolderIds: [], ...initial };
  return {
    load: () => state,
    update: (patch) => {
      state = { ...state, ...patch };
      return state;
    },
  };
}

function createFakeDriveClient() {
  const created = [];
  const updated = [];
  return {
    created,
    updated,
    files: {
      list: async ({ q }) => {
        // expandHiddenTrees walking into the hidden folder's contents.
        if (q.startsWith("'hidden-folder' in parents")) {
          return { data: { files: [{ id: 'hidden-child', mimeType: 'text/plain' }] } };
        }
        const rootFiles = [
          { id: 'file-1', name: 'Report.docx', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://drive.example/file-1' },
          { id: 'folder-1', name: 'Subfolder', mimeType: 'application/vnd.google-apps.folder' },
          { id: 'hidden-folder', name: 'Private', mimeType: 'application/vnd.google-apps.folder' },
        ];
        // Simulates a search match landing on a file that happens to live
        // inside the hidden folder — this is what expandHiddenTrees exists
        // to filter back out, even though it isn't a folder itself.
        if (q.startsWith('name contains')) {
          return { data: { files: [...rootFiles, { id: 'hidden-child', name: 'Report inside private folder', mimeType: 'text/plain' }] } };
        }
        return { data: { files: rootFiles } };
      },
      get: async ({ fileId, alt, fields }) => {
        if (alt === 'media') return { data: 'plain text content' };
        if (fields?.includes('parents')) return { data: { id: fileId, parents: ['old-parent'] } };
        return { data: { id: fileId, name: 'Report.docx', mimeType: 'application/vnd.google-apps.document' } };
      },
      export: async () => ({ data: 'exported doc text' }),
      create: async ({ requestBody }) => {
        const folder = { id: 'new-folder-1', name: requestBody.name, mimeType: requestBody.mimeType };
        created.push(folder);
        return { data: folder };
      },
      update: async (args) => {
        updated.push(args);
        return { data: { id: args.fileId, parents: [args.addParents] } };
      },
      copy: async ({ fileId, requestBody }) => ({ data: { id: `${fileId}-copy`, name: requestBody.name } }),
    },
    about: {
      get: async () => ({ data: { user: { displayName: 'Fake User', photoLink: 'https://example.com/photo.jpg', emailAddress: 'fake@example.com' } } }),
    },
  };
}

// Never touches real Google or a browser — a fake client proves the
// browse/search mapping logic (isFolder derivation, field shape) and the
// write/hide actions.
async function driveInternalTest() {
  const fakeClient = createFakeDriveClient();
  const profile = fakeProfile();
  const factoryCalls = [];
  const fakeTool = createDriveTool({
    secretStore: { get: () => null, set: () => {} },
    profile,
    driveClientFactory: async ({ allowConsent } = {}) => {
      factoryCalls.push(Boolean(allowConsent));
      return fakeClient;
    },
  });

  // authorize: the one and only action allowed to request a live consent
  // flow (regression: 2026-08-02 out-of-place-consent-prompt incident —
  // see googleAuth.js). Runs first, before the client is cached by any
  // other action, so this genuinely proves what allowConsent it passed.
  const authorized = await fakeTool.invoke({ action: 'authorize' });
  assert.strictEqual(authorized.result.authorized, true);
  assert.strictEqual(authorized.result.emailAddress, 'fake@example.com');
  assert.deepStrictEqual(factoryCalls, [true], 'authorize must request allowConsent: true');

  const browsed = await fakeTool.invoke({ action: 'browse', folderId: 'root' });
  assert.strictEqual(browsed.result.entries.length, 3);
  assert.strictEqual(browsed.result.entries.find((e) => e.id === 'folder-1').isFolder, true);
  assert.strictEqual(browsed.result.entries.find((e) => e.id === 'file-1').isFolder, false);
  assert.strictEqual(browsed.result.entries.find((e) => e.id === 'file-1').webViewLink, 'https://drive.example/file-1');

  // Home (no folderId) is a synthetic peer view — the shared OWM tree and
  // this account's own My Drive — not a real Drive query.
  const home = await fakeTool.invoke({ action: 'browse' });
  assert.strictEqual(home.result.entries.length, 2);
  assert.strictEqual(home.result.entries.find((e) => e.name === 'OWM').isFolder, true);
  assert.strictEqual(home.result.entries.find((e) => e.name === 'My Drive').id, 'root');

  const content = await fakeTool.invoke({ action: 'getContent', id: 'file-1' });
  assert.strictEqual(content.result.content, 'exported doc text');

  const createResult = await fakeTool.invoke({ action: 'createFolder', name: 'OWM', parentId: 'root' });
  assert.strictEqual(createResult.result.created, true);
  assert.strictEqual(createResult.result.folder.name, 'OWM');
  assert.strictEqual(fakeClient.created.length, 1);

  const moveResult = await fakeTool.invoke({ action: 'move', id: 'folder-1', newParentId: 'new-folder-1' });
  assert.strictEqual(moveResult.result.moved, true);
  assert.strictEqual(fakeClient.updated[0].addParents, 'new-folder-1');
  assert.strictEqual(fakeClient.updated[0].removeParents, 'old-parent');

  await fakeTool.invoke({ action: 'hideFolder', folderId: 'hidden-folder' });
  const browsedAfterHide = await fakeTool.invoke({ action: 'browse', folderId: 'root' });
  assert.ok(!browsedAfterHide.result.entries.some((e) => e.id === 'hidden-folder'), 'hidden folder must not appear in browse results');

  const searchedAfterHide = await fakeTool.invoke({ action: 'search', query: 'Report' });
  assert.ok(!searchedAfterHide.result.results.some((e) => e.id === 'hidden-folder'), 'hidden folder must not appear in search results');
  assert.ok(!searchedAfterHide.result.results.some((e) => e.id === 'hidden-child'), 'a file living inside the hidden folder must not appear in search results either');

  await fakeTool.invoke({ action: 'unhideFolder', folderId: 'hidden-folder' });
  const browsedAfterUnhide = await fakeTool.invoke({ action: 'browse', folderId: 'root' });
  assert.ok(browsedAfterUnhide.result.entries.some((e) => e.id === 'hidden-folder'), 'unhidden folder must reappear');

  const renameResult = await fakeTool.invoke({ action: 'rename', id: 'file-1', name: 'Renamed.docx' });
  assert.strictEqual(renameResult.result.renamed, true);
  assert.strictEqual(fakeClient.updated.at(-1).requestBody.name, 'Renamed.docx');

  const whoamiResult = await fakeTool.invoke({ action: 'whoami' });
  assert.strictEqual(whoamiResult.result.displayName, 'Fake User');
  assert.strictEqual(whoamiResult.result.photoLink, 'https://example.com/photo.jpg');
  assert.strictEqual(whoamiResult.result.emailAddress, 'fake@example.com');

  const trashResult = await fakeTool.invoke({ action: 'trash', id: 'file-1' });
  assert.strictEqual(trashResult.result.trashed, true);
  assert.strictEqual(fakeClient.updated.at(-1).requestBody.trashed, true);

  // The fake's default files.get reports a non-folder mimeType, so this
  // exercises copyRecursive's direct (single files.copy call) branch.
  const copyResult = await fakeTool.invoke({ action: 'copy', id: 'file-1', newParentId: 'new-folder-1' });
  assert.strictEqual(copyResult.result.copied, true);
  assert.strictEqual(copyResult.result.newId, 'file-1-copy');

  // A fresh tool that never called authorize must still request
  // allowConsent: false for an ordinary action — a plain browse must
  // never be able to trigger a live consent flow as a side effect.
  const freshFactoryCalls = [];
  const freshTool = createDriveTool({
    secretStore: { get: () => null, set: () => {} },
    profile: fakeProfile(),
    driveClientFactory: async ({ allowConsent } = {}) => {
      freshFactoryCalls.push(Boolean(allowConsent));
      return fakeClient;
    },
  });
  await freshTool.invoke({ action: 'browse', folderId: 'root' });
  assert.deepStrictEqual(freshFactoryCalls, [false], 'an ordinary action must never request allowConsent: true');

  return { passed: true };
}

/**
 * Real Google Drive browsing and organizing for whichever account
 * authorized it — no metadata catalog layer yet, this is the plain
 * "browse the real files" MVP plus enough write capability to
 * reorganize (createFolder/move) and hide a folder from this tool's own
 * browse/search results (driveHiddenFolderIds in Profile — not a real
 * Drive-level visibility control, just an app-level filter).
 * `driveClientFactory` is overridable so tests never need real
 * credentials or a browser (see driveInternalTest above).
 */
function createDriveTool({ secretStore, profile, driveClientFactory = getDriveClient }) {
  let cachedClient = null;

  return new Tool({
    name: 'drive',
    version: '2.2.0',
    description: 'Real Google Drive browsing and organizing for the account that authorized it. Call `authorize` once before anything else.',
    mcpInputSchema: {
      action: z.enum(['setup', 'authorize', 'browse', 'search', 'getContent', 'getRichContent', 'createFolder', 'move', 'hideFolder', 'unhideFolder', 'trash', 'rename', 'copy', 'whoami']).optional(),
      clientJsonPath: z.string().optional(),
      folderId: z.string().optional(),
      query: z.string().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      parentId: z.string().optional(),
      newParentId: z.string().optional(),
    },

    run: async (params) => {
      const action = params?.action ?? 'browse';

      if (action === 'setup') {
        if (!params.clientJsonPath) throw new Error('setup requires clientJsonPath');
        const contents = fs.readFileSync(params.clientJsonPath, 'utf8');
        JSON.parse(contents); // fail fast if it's not real JSON before storing it
        secretStore.set('google_oauth_client', contents);
        return { configured: true };
      }

      // The one and only place a real consent flow may start — see
      // googleAuth.js's header for why every other action below must
      // never be able to trigger one as a side effect.
      if (action === 'authorize') {
        if (!cachedClient) {
          cachedClient = await driveClientFactory({ secretStore, allowConsent: true });
        }
        const res = await cachedClient.about.get({ fields: 'user' });
        return { authorized: true, emailAddress: res.data.user.emailAddress };
      }

      if (!cachedClient) {
        cachedClient = await driveClientFactory({ secretStore });
      }

      if (action === 'browse') {
        if (params.folderId == null) {
          return {
            folderId: null,
            entries: [
              { id: OWM_ROOT_FOLDER_ID, name: 'OWM', mimeType: 'application/vnd.google-apps.folder', isFolder: true },
              { id: 'root', name: 'My Drive', mimeType: 'application/vnd.google-apps.folder', isFolder: true },
            ],
          };
        }
        const folderId = params.folderId;
        const hidden = new Set(profile.load().driveHiddenFolderIds);
        const files = await listAllPages(cachedClient, {
          q: `'${folderId}' in parents and trashed = false`,
          fields: LIST_FIELDS,
          orderBy: 'folder,name',
        });
        return { folderId, entries: files.map(mapFile).filter((f) => !hidden.has(f.id)) };
      }

      if (action === 'search') {
        const hidden = new Set(profile.load().driveHiddenFolderIds);
        const escaped = (params.query ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const files = await listAllPages(cachedClient, {
          q: `name contains '${escaped}' and trashed = false`,
          fields: LIST_FIELDS,
        });
        // Excludes the hidden folder itself and anything found inside it —
        // otherwise search would surface a private folder's contents even
        // though browse never lists the folder that leads there.
        const hiddenTrees = await expandHiddenTrees(cachedClient, hidden);
        return {
          query: params.query ?? '',
          results: files.map(mapFile).filter((f) => !hidden.has(f.id) && !hiddenTrees.has(f.id)),
        };
      }

      if (action === 'getContent') {
        if (!params.id) throw new Error('getContent requires id');
        const meta = await cachedClient.files.get({ fileId: params.id, fields: 'id, name, mimeType' });
        const { mimeType, name } = meta.data;

        const TEXT_MIME_TYPES = ['text/', 'application/json', 'application/xml', 'application/csv'];
        const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        const isNativeGoogleType = mimeType.startsWith('application/vnd.google-apps.');
        const isPlainText = TEXT_MIME_TYPES.some((prefix) => mimeType.startsWith(prefix));
        const isImage = IMAGE_MIME_TYPES.includes(mimeType);

        if (isImage) {
          const res = await cachedClient.files.get({ fileId: params.id, alt: 'media' }, { responseType: 'arraybuffer' });
          return { id: params.id, name, mimeType, imageBase64: Buffer.from(res.data).toString('base64') };
        }

        if (isNativeGoogleType) {
          const exportMimeType = mimeType === 'application/vnd.google-apps.spreadsheet' ? 'text/csv' : 'text/plain';
          const res = await cachedClient.files.export({ fileId: params.id, mimeType: exportMimeType }, { responseType: 'text' });
          return { id: params.id, name, mimeType, content: res.data };
        }

        if (isPlainText) {
          const res = await cachedClient.files.get({ fileId: params.id, alt: 'media' }, { responseType: 'text' });
          return { id: params.id, name, mimeType, content: res.data };
        }

        if (supportsExtraction(mimeType)) {
          const res = await cachedClient.files.get({ fileId: params.id, alt: 'media' }, { responseType: 'arraybuffer' });
          const buffer = Buffer.from(res.data);
          const text = await extractText({ buffer, mimeType });
          if (text) return { id: params.id, name, mimeType, content: text };
          return { id: params.id, name, mimeType, content: null, note: `Extraction ran but found no text in this ${mimeType} file.` };
        }

        return { id: params.id, name, mimeType, content: null, note: `Content type "${mimeType}" isn't text-extractable yet.` };
      }

      // Slower, full-fidelity rendering (docx->HTML via mammoth, PDF
      // pages->PNG via pdfjs-dist) — a deliberately separate action from
      // getContent so a caller can show the fast plain-text preview
      // immediately and upgrade to this in the background. See
      // src/core/richPreview.js and sample-app/index.html's preview loader.
      if (action === 'getRichContent') {
        if (!params.id) throw new Error('getRichContent requires id');
        const meta = await cachedClient.files.get({ fileId: params.id, fields: 'id, name, mimeType' });
        const { mimeType, name } = meta.data;

        if (!supportsRichPreview(mimeType)) {
          return { id: params.id, name, mimeType, supported: false };
        }
        const res = await cachedClient.files.get({ fileId: params.id, alt: 'media' }, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(res.data);
        const rendered = await renderRichPreview(buffer, mimeType);
        return { id: params.id, name, mimeType, supported: true, ...rendered };
      }

      if (action === 'createFolder') {
        if (!params.name) throw new Error('createFolder requires name');
        const res = await cachedClient.files.create({
          requestBody: {
            name: params.name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: params.parentId ? [params.parentId] : undefined,
          },
          fields: 'id, name, mimeType, webViewLink',
        });
        return { created: true, folder: mapFile(res.data) };
      }

      if (action === 'move') {
        if (!params.id) throw new Error('move requires id');
        if (!params.newParentId) throw new Error('move requires newParentId');
        const meta = await cachedClient.files.get({ fileId: params.id, fields: 'id, parents' });
        const previousParents = (meta.data.parents ?? []).join(',');
        await cachedClient.files.update({
          fileId: params.id,
          addParents: params.newParentId,
          removeParents: previousParents,
          fields: 'id, parents',
        });
        return { moved: true, id: params.id, newParentId: params.newParentId };
      }

      if (action === 'hideFolder') {
        if (!params.folderId) throw new Error('hideFolder requires folderId');
        const current = profile.load().driveHiddenFolderIds;
        profile.update({ driveHiddenFolderIds: [...new Set([...current, params.folderId])] });
        return { hidden: true, folderId: params.folderId };
      }

      if (action === 'unhideFolder') {
        if (!params.folderId) throw new Error('unhideFolder requires folderId');
        const current = profile.load().driveHiddenFolderIds;
        profile.update({ driveHiddenFolderIds: current.filter((id) => id !== params.folderId) });
        return { hidden: false, folderId: params.folderId };
      }

      if (action === 'whoami') {
        const res = await cachedClient.about.get({ fields: 'user' });
        const { displayName, photoLink, emailAddress } = res.data.user;
        return { displayName, photoLink, emailAddress };
      }

      if (action === 'trash') {
        if (!params.id) throw new Error('trash requires id');
        await cachedClient.files.update({ fileId: params.id, requestBody: { trashed: true } });
        return { trashed: true, id: params.id };
      }

      if (action === 'rename') {
        if (!params.id) throw new Error('rename requires id');
        if (!params.name) throw new Error('rename requires name');
        await cachedClient.files.update({ fileId: params.id, requestBody: { name: params.name } });
        return { renamed: true, id: params.id, name: params.name };
      }

      if (action === 'copy') {
        if (!params.id) throw new Error('copy requires id');
        if (!params.newParentId) throw new Error('copy requires newParentId');
        const newId = await copyRecursive(cachedClient, params.id, params.newParentId);
        return { copied: true, id: params.id, newId, newParentId: params.newParentId };
      }

      throw new Error(`Unknown drive action: ${action}`);
    },

    internalTest: driveInternalTest,

    // Requires a real configured account; testConfig.folderId names which
    // folder to check against. Generic sweeps that don't know about this
    // tool's specific needs (no folderId in their testConfig) skip
    // gracefully instead of accidentally making a real Google API call.
    realWorldTest: async (testConfig, { call }) => {
      if (!testConfig.folderId) {
        return { passed: true, skipped: true, reason: 'testConfig.folderId not provided — skipping real Drive check' };
      }
      const { result } = await call({ action: 'browse', folderId: testConfig.folderId });
      assert.ok(Array.isArray(result.entries));
      return { passed: true, checkedAgainst: testConfig.label ?? 'unnamed-fixture' };
    },
  });
}

module.exports = { createDriveTool };
