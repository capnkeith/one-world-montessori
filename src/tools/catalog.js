'use strict';

const assert = require('node:assert');
const { z } = require('zod');
const { Tool } = require('../core/Tool');

/**
 * File catalog front end: instant folder browsing and search over
 * whatever's currently loaded in the local FileCatalog index, plus
 * `sync` to pull new patches from the event log and `reportPatch` for
 * crawlers/enrichment systems to contribute additive metadata. Actually
 * opening a file's real content is deliberately NOT here yet — that
 * needs real per-user Drive OAuth, a separate not-yet-built piece.
 */
function createCatalogTool({ eventLog, catalogRef, persistSnapshot }) {
  return new Tool({
    name: 'catalog',
    version: '1.0.0',
    description: 'Instant file/folder browsing and search over the local metadata index; sync pulls new patches, reportPatch records additive metadata.',
    mcpInputSchema: {
      action: z.enum(['browse', 'search', 'getFile', 'reportPatch', 'sync']).optional(),
      parentId: z.string().nullable().optional(),
      query: z.string().optional(),
      id: z.string().optional(),
      targetId: z.string().optional(),
      source: z.string().optional(),
      patch: z.any().optional(),
    },

    run: async (params) => {
      const action = params?.action ?? 'browse';
      const catalog = catalogRef();

      switch (action) {
        case 'browse':
          return { parentId: params.parentId ?? null, entries: catalog.listFolder(params.parentId ?? null) };

        case 'search':
          return { query: params.query ?? '', results: catalog.search(params.query ?? '') };

        case 'getFile': {
          const file = catalog.getById(params.id);
          return { file, duplicates: file ? catalog.findDuplicatesOf(params.id) : [] };
        }

        case 'reportPatch': {
          if (!params.targetId) throw new Error('reportPatch requires targetId');
          const event = await eventLog.append({
            targetId: params.targetId,
            source: params.source ?? 'unknown',
            patch: params.patch ?? {},
          });
          catalog.applyEvent(event);
          persistSnapshot?.();
          return { recorded: true, id: event.id, seq: event.seq };
        }

        case 'sync': {
          const since = catalog.lastSeq;
          const events = await eventLog.streamSince(since);
          for (const event of events) catalog.applyEvent(event);
          if (events.length) persistSnapshot?.();
          return { appliedThrough: catalog.lastSeq, newEvents: events.length };
        }

        default:
          throw new Error(`Unknown catalog action: ${action}`);
      }
    },

    internalTest: async ({ call }) => {
      const folderPatch = await call({
        action: 'reportPatch',
        targetId: 'test-folder',
        source: 'internal-test',
        patch: { name: 'Test Folder', isFolder: true, parentIds: [] },
      });
      assert.strictEqual(folderPatch.result.recorded, true);

      const filePatch = await call({
        action: 'reportPatch',
        targetId: 'test-file',
        source: 'internal-test',
        patch: { name: 'report.pdf', mimeType: 'application/pdf', parentIds: ['test-folder'], contentHash: 'abc123' },
      });
      assert.strictEqual(filePatch.result.recorded, true);

      const browsed = await call({ action: 'browse', parentId: 'test-folder' });
      assert.ok(browsed.result.entries.some((e) => e.id === 'test-file'));

      const searched = await call({ action: 'search', query: 'report' });
      assert.ok(searched.result.results.some((e) => e.id === 'test-file'));

      const fetched = await call({ action: 'getFile', id: 'test-file' });
      assert.strictEqual(fetched.result.file.name, 'report.pdf');

      return { passed: true };
    },

    realWorldTest: async (testConfig, { call }) => {
      const { result } = await call({ action: 'sync' });
      assert.ok(typeof result.appliedThrough === 'number');
      return { passed: true, checkedAgainst: testConfig.label ?? 'unnamed-fixture' };
    },
  });
}

module.exports = { createCatalogTool };
