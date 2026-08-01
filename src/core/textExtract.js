'use strict';

const JSZip = require('jszip');

/**
 * Best-effort text extraction for common real-world file types, used by
 * the `drive` tool's getContent action so preview actually works for the
 * Office/PDF documents that make up most of a real Drive — not just
 * Google-native docs and plain text.
 *
 * `pdfParseFn` is injectable so tests never need a real PDF file or the
 * real pdf-parse module (see test/textExtract.test.js).
 */

function stripXmlTags(fragment) {
  return fragment.replace(/<[^>]+>/g, '');
}

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * .docx: word/document.xml, text runs are <w:t>...</w:t>, grouped into
 * paragraphs by <w:p>...</w:p>. Runs within a paragraph join directly
 * (a run boundary isn't a word boundary), but paragraphs join with a
 * newline each — joining every run in the whole document with '' instead
 * mashes separate paragraphs into one unreadable line.
 */
async function extractDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const doc = zip.file('word/document.xml');
  if (!doc) return null;
  const xml = await doc.async('string');
  const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>(.*?)<\/w:p>/gs)].map((p) => {
    const runs = [...p[1].matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gs)].map((m) => decodeXmlEntities(m[1]));
    return runs.join('');
  });
  return paragraphs.join('\n').trim() || null;
}

/** .pptx: one XML per slide under ppt/slides/, text runs are <a:t>...</a:t>. */
async function extractPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml/)[1]);
      const nb = Number(b.match(/slide(\d+)\.xml/)[1]);
      return na - nb;
    });

  const slideTexts = [];
  for (const path of slidePaths) {
    const xml = await zip.file(path).async('string');
    const runs = [...xml.matchAll(/<a:t[^>]*>(.*?)<\/a:t>/gs)].map((m) => decodeXmlEntities(m[1]));
    slideTexts.push(runs.join(' ').trim());
  }
  return slideTexts.length ? slideTexts.map((t, i) => `--- Slide ${i + 1} ---\n${t}`).join('\n\n') : null;
}

/**
 * .xlsx: resolves shared strings and reconstructs the first worksheet as a
 * simple tab-separated grid. Good enough for a preview, not a full parser
 * (formulas/formatting/multiple sheets aren't reconstructed).
 */
async function extractXlsx(buffer) {
  const zip = await JSZip.loadAsync(buffer);

  let sharedStrings = [];
  const sharedStringsFile = zip.file('xl/sharedStrings.xml');
  if (sharedStringsFile) {
    const xml = await sharedStringsFile.async('string');
    sharedStrings = [...xml.matchAll(/<si>(.*?)<\/si>/gs)].map((m) => {
      const text = [...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((t) => t[1]).join('');
      return decodeXmlEntities(text);
    });
  }

  const sheetPaths = Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort();
  if (!sheetPaths.length) return null;

  const sheetXml = await zip.file(sheetPaths[0]).async('string');
  const rowMatches = [...sheetXml.matchAll(/<row[^>]*>(.*?)<\/row>/gs)];

  const rows = rowMatches.map((rowMatch) => {
    // Two-step parse (attributes, then value) rather than one combined
    // regex — a single pattern with an optional `t="s"` group in the
    // middle unreliably skips that group via backtracking, silently
    // returning raw shared-string indices instead of resolved text.
    const cellMatches = [...rowMatch[1].matchAll(/<c\b([^>]*)>(?:<v>(.*?)<\/v>)?<\/c>/gs)];
    return cellMatches
      .map(([, attrs, value]) => {
        if (value === undefined) return '';
        const typeMatch = attrs.match(/\bt="([^"]*)"/);
        if (typeMatch?.[1] === 's') return sharedStrings[Number(value)] ?? '';
        return value;
      })
      .join('\t');
  });

  return rows.length ? rows.join('\n') : null;
}

// pdf-parse v2's real API is a class (`new PDFParse({data}).getText()`), not
// a plain function — wrapped here so extractPdf's own interface (and what
// tests inject) stays a simple `buffer => {text}` function regardless of
// how the underlying library's API shifts in future versions.
async function defaultPdfParse(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    return await parser.getText();
  } finally {
    await parser.destroy?.();
  }
}

async function extractPdf(buffer, { pdfParseFn }) {
  const result = await pdfParseFn(buffer);
  return result.text?.trim() || null;
}

// Legacy binary .doc (OLE/CFBF, not a zip — completely different format
// from .docx) via word-extractor.
async function defaultDocExtract(buffer) {
  const WordExtractor = require('word-extractor');
  const doc = await new WordExtractor().extract(buffer);
  return doc.getBody();
}

async function extractDoc(buffer, { docExtractFn }) {
  const text = await docExtractFn(buffer);
  return text?.trim() || null;
}

// Legacy binary .xls (BIFF, not a zip) via SheetJS. Installed from
// cdn.sheetjs.com rather than the npm registry — the npm-published `xlsx`
// package is a stale, unpatched version with known high-severity CVEs
// (prototype pollution, ReDoS) that SheetJS never fixed there; the CDN
// tarball is their own recommended distribution for current, patched code.
function defaultXlsExtract(buffer) {
  const XLSX = require('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return null;
  return XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName], { FS: '\t' });
}

async function extractXls(buffer, { xlsExtractFn }) {
  const text = await xlsExtractFn(buffer);
  return text?.trim() || null;
}

const EXTRACTORS = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (buffer) => extractDocx(buffer),
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': (buffer) => extractPptx(buffer),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (buffer) => extractXlsx(buffer),
  'application/pdf': extractPdf,
  'application/msword': extractDoc,
  'application/vnd.ms-excel': extractXls,
};

function supportsExtraction(mimeType) {
  return Object.prototype.hasOwnProperty.call(EXTRACTORS, mimeType);
}

/**
 * Returns extracted text, or null if extraction ran but found nothing /
 * isn't supported for this type. The three *Fn params are injectable so
 * tests never need real binary fixtures for pdf-parse/word-extractor/xlsx
 * (constructing a valid legacy .doc/.xls by hand isn't practical) — only
 * the zip-based formats (.docx/.xlsx/.pptx) get real fixtures in tests,
 * built on the fly with jszip.
 */
async function extractText({
  buffer,
  mimeType,
  pdfParseFn = defaultPdfParse,
  docExtractFn = defaultDocExtract,
  xlsExtractFn = defaultXlsExtract,
}) {
  const extractor = EXTRACTORS[mimeType];
  if (!extractor) return null;
  return extractor(buffer, { pdfParseFn, docExtractFn, xlsExtractFn });
}

module.exports = { extractText, supportsExtraction, stripXmlTags };
