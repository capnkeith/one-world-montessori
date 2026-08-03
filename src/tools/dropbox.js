'use strict';

const assert = require('node:assert');
const { z } = require('zod');
const { Tool } = require('../core/Tool');
const { getDropboxClient } = require('../core/dropboxAuth');

function mapEntry(e) {
  return {
    id: e.id,
    name: e.name,
    path: e.path_lower,
    isFolder: e['.tag'] === 'folder',
    size: e.size ?? null,
    contentHash: e.content_hash ?? null,
    modifiedTime: e.server_modified ?? null,
  };
}

/**
 * Real (read-only) Dropbox browsing — mirrors src/tools/drive.js's
 * shape so the two feel the same from a caller's perspective. Dropbox
 * addresses things by path (not a folder-id tree like Drive), so
 * `folderId` here is actually a path ("" for root).
 */
function createDropboxTool({ secretStore, sharedSecretStore, dropboxClientFactory = getDropboxClient }) {
  let cachedClient = null;

  return new Tool({
    name: 'dropbox',
    version: '1.1.0',
    description: 'Real Dropbox browsing (read-only) for the account that authorized it. Call `authorize` once (after `setup`) before anything else.',
    mcpInputSchema: {
      action: z.enum(['setup', 'authorize', 'browse', 'search', 'getContent']).optional(),
      appKey: z.string().optional(),
      folderId: z.string().optional(),
      query: z.string().optional(),
      path: z.string().optional(),
    },

    run: async (params) => {
      const action = params?.action ?? 'browse';

      if (action === 'setup') {
        if (!params.appKey) throw new Error('setup requires appKey');
        secretStore.set('dropbox_app_key', params.appKey);
        return { configured: true };
      }

      // The one and only place a real consent flow may start — see
      // dropboxAuth.js's header for why every other action below must
      // never be able to trigger one as a side effect.
      if (action === 'authorize') {
        if (!cachedClient) {
          cachedClient = await dropboxClientFactory({ secretStore, sharedSecretStore, allowConsent: true });
        }
        const res = await cachedClient.call('users/get_current_account', {});
        return { authorized: true, email: res.email ?? null };
      }

      if (!cachedClient) {
        cachedClient = await dropboxClientFactory({ secretStore, sharedSecretStore });
      }

      if (action === 'browse') {
        const folderPath = params.folderId === 'root' || !params.folderId ? '' : params.folderId;
        const res = await cachedClient.call('files/list_folder', { path: folderPath });
        return { folderId: folderPath || 'root', entries: (res.entries ?? []).map(mapEntry) };
      }

      if (action === 'search') {
        const res = await cachedClient.call('files/search_v2', { query: params.query ?? '' });
        const matches = (res.matches ?? []).map((m) => mapEntry(m.metadata.metadata));
        return { query: params.query ?? '', results: matches };
      }

      if (action === 'getContent') {
        if (!params.path) throw new Error('getContent requires path');
        const content = await cachedClient.download(params.path);
        return { path: params.path, content };
      }

      throw new Error(`Unknown dropbox action: ${action}`);
    },

    // Never touches real Dropbox — a fake client proves the mapping logic.
    internalTest: async () => {
      const fakeClient = {
        call: async (endpoint, body) => {
          if (endpoint === 'files/list_folder') {
            return {
              entries: [
                { '.tag': 'folder', id: 'id:folder1', name: 'Photos', path_lower: '/photos' },
                { '.tag': 'file', id: 'id:file1', name: 'report.pdf', path_lower: '/report.pdf', size: 123 },
              ],
            };
          }
          if (endpoint === 'files/search_v2') {
            return { matches: [{ metadata: { metadata: { '.tag': 'file', id: 'id:file1', name: 'report.pdf', path_lower: '/report.pdf' } } }] };
          }
          if (endpoint === 'users/get_current_account') {
            return { email: 'fake@example.com' };
          }
          throw new Error(`unexpected endpoint ${endpoint}`);
        },
        download: async () => 'fake file content',
      };
      const factoryCalls = [];
      const fakeTool = createDropboxTool({
        secretStore: { get: () => null, set: () => {} },
        dropboxClientFactory: async ({ allowConsent } = {}) => {
          factoryCalls.push(Boolean(allowConsent));
          return fakeClient;
        },
      });

      // authorize: the one and only action allowed to request a live
      // consent flow (regression: 2026-08-02 out-of-place-consent-prompt
      // incident — see dropboxAuth.js). Runs first, before the client is
      // cached by any other action, so this genuinely proves what
      // allowConsent it passed.
      const authorized = await fakeTool.invoke({ action: 'authorize' });
      assert.strictEqual(authorized.result.authorized, true);
      assert.strictEqual(authorized.result.email, 'fake@example.com');
      assert.deepStrictEqual(factoryCalls, [true], 'authorize must request allowConsent: true');

      const browsed = await fakeTool.invoke({ action: 'browse', folderId: 'root' });
      assert.strictEqual(browsed.result.entries.length, 2);
      assert.strictEqual(browsed.result.entries.find((e) => e.id === 'id:folder1').isFolder, true);

      const searched = await fakeTool.invoke({ action: 'search', query: 'report' });
      assert.strictEqual(searched.result.results.length, 1);

      const content = await fakeTool.invoke({ action: 'getContent', path: '/report.pdf' });
      assert.strictEqual(content.result.content, 'fake file content');

      // A fresh tool that never called authorize must still request
      // allowConsent: false for an ordinary action.
      const freshFactoryCalls = [];
      const freshTool = createDropboxTool({
        secretStore: { get: () => null, set: () => {} },
        dropboxClientFactory: async ({ allowConsent } = {}) => {
          freshFactoryCalls.push(Boolean(allowConsent));
          return fakeClient;
        },
      });
      await freshTool.invoke({ action: 'browse', folderId: 'root' });
      assert.deepStrictEqual(freshFactoryCalls, [false], 'an ordinary action must never request allowConsent: true');

      return { passed: true };
    },

    realWorldTest: async (testConfig, { call }) => {
      if (!testConfig.folderId) {
        return { passed: true, skipped: true, reason: 'testConfig.folderId not provided — skipping real Dropbox check' };
      }
      const { result } = await call({ action: 'browse', folderId: testConfig.folderId });
      assert.ok(Array.isArray(result.entries));
      return { passed: true, checkedAgainst: testConfig.label ?? 'unnamed-fixture' };
    },
  });
}

module.exports = { createDropboxTool };
