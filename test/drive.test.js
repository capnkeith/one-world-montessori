'use strict';

const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { createDriveTool } = require('../src/tools/drive');

function fakeSecretStore(initial = {}) {
  const store = { ...initial };
  return {
    get: (k) => store[k] ?? null,
    set: (k, v) => {
      store[k] = v;
    },
    has: (k) => store[k] != null,
  };
}

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

function fakeDriveClient(files) {
  return {
    files: {
      list: async ({ q }) => {
        if (q.includes('name contains')) {
          const needle = q.match(/name contains '(.*?)'/)[1];
          return { data: { files: files.filter((f) => f.name.includes(needle)) } };
        }
        const parent = q.match(/'(.*?)' in parents/)[1];
        return { data: { files: files.filter((f) => f.parent === parent) } };
      },
    },
  };
}

const FIXTURE_FILES = [
  { id: 'folder-1', name: 'Photos', mimeType: 'application/vnd.google-apps.folder', parent: 'root' },
  { id: 'file-1', name: 'Report.docx', mimeType: 'application/vnd.google-apps.document', parent: 'root' },
  { id: 'file-2', name: 'Report Archive.pdf', mimeType: 'application/pdf', parent: 'folder-1' },
];

test('browse lists only the requested folder\'s direct children, marking folders correctly', async () => {
  const tool = createDriveTool({
    secretStore: fakeSecretStore(),
    profile: fakeProfile(),
    driveClientFactory: async () => fakeDriveClient(FIXTURE_FILES),
  });

  const { result } = await tool.invoke({ action: 'browse', folderId: 'root' });
  assert.strictEqual(result.entries.length, 2);
  assert.strictEqual(result.entries.find((e) => e.id === 'folder-1').isFolder, true);
  assert.strictEqual(result.entries.find((e) => e.id === 'file-1').isFolder, false);
});

test('search matches by name across the fake corpus', async () => {
  const tool = createDriveTool({
    secretStore: fakeSecretStore(),
    profile: fakeProfile(),
    driveClientFactory: async () => fakeDriveClient(FIXTURE_FILES),
  });

  const { result } = await tool.invoke({ action: 'search', query: 'Report' });
  assert.strictEqual(result.results.length, 2);
});

test('setup validates and stores the client JSON without ever needing a real file for this test', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'owm-drive-test-')), 'client.json');
  fs.writeFileSync(tmpFile, JSON.stringify({ installed: { client_id: 'x', client_secret: 'y' } }));

  const secretStore = fakeSecretStore();
  const tool = createDriveTool({ secretStore, profile: fakeProfile(), driveClientFactory: async () => fakeDriveClient([]) });

  const { result } = await tool.invoke({ action: 'setup', clientJsonPath: tmpFile });
  assert.strictEqual(result.configured, true);
  assert.ok(secretStore.has('google_oauth_client'));
});

test('getContent extracts real text from a .docx via the extraction pipeline, not just a stub', async () => {
  const zip = new JSZip();
  zip.file(
    'word/document.xml',
    '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Board minutes for June</w:t></w:r></w:p></w:body></w:document>'
  );
  const docxBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  const fakeClient = {
    files: {
      get: async ({ fileId, alt }) => {
        if (alt === 'media') return { data: docxBuffer };
        return { data: { id: fileId, name: 'minutes.docx', mimeType } };
      },
    },
  };
  const tool = createDriveTool({ secretStore: fakeSecretStore(), profile: fakeProfile(), driveClientFactory: async () => fakeClient });

  const { result } = await tool.invoke({ action: 'getContent', id: 'file-x' });
  assert.match(result.content, /Board minutes for June/);
});

test('getContent returns base64 image bytes for image files instead of treating them as not-extractable text', async () => {
  const fakeBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // fake JPEG-ish bytes, never a real image
  const mimeType = 'image/jpeg';

  const fakeClient = {
    files: {
      get: async ({ fileId, alt }) => {
        if (alt === 'media') return { data: fakeBytes };
        return { data: { id: fileId, name: 'photo.jpg', mimeType } };
      },
    },
  };
  const tool = createDriveTool({ secretStore: fakeSecretStore(), profile: fakeProfile(), driveClientFactory: async () => fakeClient });

  const { result } = await tool.invoke({ action: 'getContent', id: 'file-img' });
  assert.strictEqual(result.mimeType, mimeType);
  assert.strictEqual(result.content, undefined);
  assert.strictEqual(result.imageBase64, fakeBytes.toString('base64'));
});

test('getRichContent renders a .docx into real HTML through the drive tool action', async () => {
  const zip = new JSZip();
  zip.file(
    'word/document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:r><w:t>Board minutes for June</w:t></w:r></w:p></w:body></w:document>'
  );
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>'
  );
  const docxBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  const fakeClient = {
    files: {
      get: async ({ fileId, alt }) => {
        if (alt === 'media') return { data: docxBuffer };
        return { data: { id: fileId, name: 'minutes.docx', mimeType } };
      },
    },
  };
  const tool = createDriveTool({ secretStore: fakeSecretStore(), profile: fakeProfile(), driveClientFactory: async () => fakeClient });

  const { result } = await tool.invoke({ action: 'getRichContent', id: 'file-x' });
  assert.strictEqual(result.supported, true);
  assert.strictEqual(result.type, 'html');
  assert.match(result.html, /Board minutes for June/);
});

test('getRichContent reports unsupported: false for a mimeType with no rich renderer, without fetching file bytes', async () => {
  let mediaFetched = false;
  const mimeType = 'image/jpeg';
  const fakeClient = {
    files: {
      get: async ({ fileId, alt }) => {
        if (alt === 'media') {
          mediaFetched = true;
          return { data: Buffer.from('should not be reached') };
        }
        return { data: { id: fileId, name: 'photo.jpg', mimeType } };
      },
    },
  };
  const tool = createDriveTool({ secretStore: fakeSecretStore(), profile: fakeProfile(), driveClientFactory: async () => fakeClient });

  const { result } = await tool.invoke({ action: 'getRichContent', id: 'file-img' });
  assert.strictEqual(result.supported, false);
  assert.strictEqual(mediaFetched, false);
});

test('copy recursively duplicates a folder tree, not just an empty shell', async () => {
  const tree = {
    'folder-A': { name: 'A', mimeType: 'application/vnd.google-apps.folder', parent: 'root' },
    'file-F1': { name: 'F1.txt', mimeType: 'text/plain', parent: 'folder-A' },
    'folder-B': { name: 'B', mimeType: 'application/vnd.google-apps.folder', parent: 'folder-A' },
    'file-F2': { name: 'F2.txt', mimeType: 'text/plain', parent: 'folder-B' },
  };
  const createdFolders = [];
  const copiedFiles = [];
  let nextId = 1;

  const fakeClient = {
    files: {
      get: async ({ fileId }) => {
        const node = tree[fileId];
        return { data: { id: fileId, name: node.name, mimeType: node.mimeType } };
      },
      list: async ({ q }) => {
        const parentId = q.match(/'(.*?)' in parents/)[1];
        const children = Object.keys(tree).filter((id) => tree[id].parent === parentId);
        return { data: { files: children.map((id) => ({ id })) } };
      },
      create: async ({ requestBody }) => {
        const id = `new-folder-${nextId++}`;
        createdFolders.push({ id, name: requestBody.name, parent: requestBody.parents[0] });
        return { data: { id } };
      },
      copy: async ({ fileId, requestBody }) => {
        const id = `${fileId}-copy`;
        copiedFiles.push({ sourceId: fileId, name: requestBody.name, parent: requestBody.parents[0] });
        return { data: { id } };
      },
    },
  };

  const tool = createDriveTool({ secretStore: fakeSecretStore(), profile: fakeProfile(), driveClientFactory: async () => fakeClient });
  const { result } = await tool.invoke({ action: 'copy', id: 'folder-A', newParentId: 'target-root' });

  assert.strictEqual(result.copied, true);
  assert.strictEqual(result.newId, 'new-folder-1');

  assert.strictEqual(createdFolders.length, 2);
  assert.deepStrictEqual(createdFolders[0], { id: 'new-folder-1', name: 'A', parent: 'target-root' });
  assert.deepStrictEqual(createdFolders[1], { id: 'new-folder-2', name: 'B', parent: 'new-folder-1' });

  assert.strictEqual(copiedFiles.length, 2);
  assert.deepStrictEqual(copiedFiles[0], { sourceId: 'file-F1', name: 'F1.txt', parent: 'new-folder-1' });
  assert.deepStrictEqual(copiedFiles[1], { sourceId: 'file-F2', name: 'F2.txt', parent: 'new-folder-2' });
});

test('realWorldTest skips gracefully when no folderId is supplied (never makes a real Google call by accident)', async () => {
  const tool = createDriveTool({ secretStore: fakeSecretStore(), profile: fakeProfile(), driveClientFactory: async () => fakeDriveClient([]) });
  const outcome = await tool.runRealWorldTest({ label: 'generic-sweep' });
  assert.strictEqual(outcome.passed, true);
  assert.strictEqual(outcome.skipped, true);
});
