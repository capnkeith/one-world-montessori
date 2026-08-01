'use strict';

const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { supportsRichPreview, renderRichPreview } = require('../src/core/richPreview');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';

// Mammoth needs a minimal real docx package (content types + rels), not
// just a bare document.xml — a plain JSZip.file('word/document.xml', ...)
// alone isn't enough for it to recognize the archive as a docx.
async function buildMinimalDocx({ heading, boldText, plainText }) {
  const zip = new JSZip();
  zip.file(
    'word/document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${heading}</w:t></w:r></w:p>` +
      `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${boldText}</w:t></w:r><w:r><w:t> ${plainText}</w:t></w:r></w:p>` +
      '</w:body></w:document>'
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
  return zip.generateAsync({ type: 'nodebuffer' });
}

// Hand-built one-page PDF (no embedded font — exercises the
// standardFontDataUrl path) rather than a real binary fixture, same
// doctrine as the rest of the suite: never depend on a real file on disk.
const MINIMAL_PDF = Buffer.from(
  `%PDF-1.1
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 44 >>
stream
BT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET
endstream
endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Size 6 /Root 1 0 R >>
%%EOF`,
  'binary'
);

test('supportsRichPreview recognizes docx and pdf, nothing else', () => {
  assert.strictEqual(supportsRichPreview(DOCX_MIME), true);
  assert.strictEqual(supportsRichPreview(PDF_MIME), true);
  assert.strictEqual(supportsRichPreview('image/jpeg'), false);
  assert.strictEqual(supportsRichPreview('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), false);
});

test('renders a .docx into real HTML with heading and bold preserved, not just plain text', async () => {
  const buffer = await buildMinimalDocx({ heading: 'A Heading', boldText: 'Bold text', plainText: 'and normal text.' });
  const result = await renderRichPreview(buffer, DOCX_MIME);
  assert.strictEqual(result.type, 'html');
  assert.match(result.html, /<h1[^>]*>A Heading<\/h1>/);
  assert.match(result.html, /<strong>Bold text<\/strong>/);
});

test('renders a PDF page to a PNG image', async () => {
  const result = await renderRichPreview(MINIMAL_PDF, PDF_MIME);
  assert.strictEqual(result.type, 'pages');
  assert.strictEqual(result.pageImages.length, 1);
  assert.strictEqual(result.totalPages, 1);
  assert.strictEqual(result.truncated, false);
  // PNG signature bytes, base64-decoded, prove it's a real image and not just text pretending to be one.
  const pngHeader = Buffer.from(result.pageImages[0], 'base64').subarray(0, 8);
  assert.deepStrictEqual([...pngHeader], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('renderRichPreview returns null for a mimeType it does not know how to render', async () => {
  const result = await renderRichPreview(Buffer.from('irrelevant'), 'image/jpeg');
  assert.strictEqual(result, null);
});

// Regression test for a real bug: pdf-parse (used by textExtract.js's fast
// tier) bundles its own nested pdfjs-dist + @napi-rs/canvas. If those ever
// drift out of lockstep with the top-level versions this module uses, two
// different copies of a "singleton-like" native/JS module end up loaded in
// the same process — but ONLY once something has actually exercised
// pdf-parse's internal PDF parsing first. A plain single-shot test of
// renderRichPreview alone (like the one above) never triggers pdf-parse's
// side of that, so it can't catch the drift — this test deliberately runs
// both in the order a real server request sequence does (fast preview,
// then rich preview) in one process.
test('rendering a PDF page still works after pdf-parse has already run in this same process (fast tier, then rich tier)', async () => {
  const { extractText } = require('../src/core/textExtract');
  const fastText = await extractText({ buffer: MINIMAL_PDF, mimeType: PDF_MIME });
  assert.ok(typeof fastText === 'string' || fastText === null); // just needs to have run, not assert on content

  const result = await renderRichPreview(MINIMAL_PDF, PDF_MIME);
  assert.strictEqual(result.type, 'pages');
  assert.strictEqual(result.pageImages.length, 1);
  const pngHeader = Buffer.from(result.pageImages[0], 'base64').subarray(0, 8);
  assert.deepStrictEqual([...pngHeader], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});
