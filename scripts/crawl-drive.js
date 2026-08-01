#!/usr/bin/env node
'use strict';

const { createContext } = require('../src/context');
const { TAG_VOCABULARY } = require('../src/core/FileCatalog');

/**
 * First-pass, heuristic tagging — cheap substring/regex matching against
 * name + folder path + mimeType, NOT deep content analysis (that's the
 * later photo-recognition/deep-mining work this whole system was built
 * to accommodate). Every file starts with origin: 'unknown' (set by
 * FileCatalog's blank record) until a real Dropbox-history scan updates it.
 */
function guessTags({ name, folderPathNames, mimeType }) {
  const haystack = `${name} ${folderPathNames.join(' ')}`.toLowerCase();
  const tags = new Set();

  for (const tag of TAG_VOCABULARY) {
    if (haystack.includes(tag)) tags.add(tag);
  }

  if (mimeType?.startsWith('image/')) tags.add('picture');
  if (mimeType?.startsWith('video/')) tags.add('video');
  if (/board/.test(haystack)) tags.add('board');
  if (/budget|funding|grant|donation|capital campaign/.test(haystack)) tags.add('funding');
  if (/alumni/.test(haystack)) tags.add('alumni');
  if (/staff|personnel|hr\b/.test(haystack)) tags.add('staff');
  if (/student|enrollment|admission/.test(haystack)) tags.add('student');
  if (/policy|procedure|handbook|manual/.test(haystack)) tags.add('guide');
  if (/\bplan\b|strategic/.test(haystack)) tags.add('plan');
  if (/office|admin/.test(haystack)) tags.add('office');
  if (/newsletter|outreach|marketing|flyer/.test(haystack)) tags.add('outreach');

  return [...tags];
}

async function crawlFolder(toolSet, folderId, folderPathNames, stats) {
  const { result } = await toolSet.invoke('drive', { action: 'browse', folderId });

  for (const entry of result.entries) {
    const tags = guessTags({ name: entry.name, folderPathNames, mimeType: entry.mimeType });

    await toolSet.invoke('catalog', {
      action: 'reportPatch',
      targetId: entry.id,
      source: 'drive-crawl-v1',
      patch: {
        name: entry.name,
        mimeType: entry.mimeType,
        isFolder: entry.isFolder,
        parentIds: folderId === 'root' ? [] : [folderId],
        locations: [{ system: 'drive', ref: entry.id, addedAt: new Date().toISOString(), isPrimary: true }],
        contentHash: entry.md5Checksum ?? null,
        size: entry.size != null ? Number(entry.size) : null,
        tags,
      },
    });

    stats.count += 1;
    if (stats.count % 50 === 0) console.log(`...indexed ${stats.count} entries so far`);

    if (entry.isFolder) {
      await crawlFolder(toolSet, entry.id, [...folderPathNames, entry.name], stats);
    }
  }
}

async function main() {
  const { toolSet, catalog } = createContext();
  const stats = { count: 0 };

  console.log('Starting full Drive crawl + first-pass tagging...');
  await crawlFolder(toolSet, 'root', [], stats);

  console.log(`Crawl complete. Indexed ${stats.count} entries (catalog lastSeq=${catalog.lastSeq}).`);

  // Quick summary: tag frequency, so there's something concrete to report.
  const tagCounts = {};
  for (const record of catalog.snapshot().records) {
    for (const tag of record.tags ?? []) {
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }
  }
  console.log('Tag frequency:', JSON.stringify(tagCounts, null, 2));
}

main().catch((err) => {
  console.error('Crawl failed:', err);
  process.exit(1);
});
