'use strict';

const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { extractText, supportsExtraction } = require('../src/core/textExtract');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function buildDocxBuffer(paragraphs) {
  const zip = new JSZip();
  const runs = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document><w:body>${runs}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function buildPptxBuffer(slidesText) {
  const zip = new JSZip();
  slidesText.forEach((text, i) => {
    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<?xml version="1.0"?><p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    );
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

function buildXlsxBuffer() {
  const zip = new JSZip();
  zip.file(
    'xl/sharedStrings.xml',
    '<?xml version="1.0"?><sst><si><t>Name</t></si><si><t>Amount</t></si><si><t>Alice</t></si></sst>'
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0"?><worksheet><sheetData>
       <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
       <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c></row>
     </sheetData></worksheet>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('extracts text from a .docx buffer', async () => {
  const buffer = await buildDocxBuffer(['Hello world', 'Second paragraph']);
  const text = await extractText({ buffer, mimeType: DOCX_MIME });
  assert.match(text, /Hello world/);
  assert.match(text, /Second paragraph/);
});

test('.docx paragraphs stay on separate lines instead of being mashed together', async () => {
  const buffer = await buildDocxBuffer(['Hello world', 'Second paragraph']);
  const text = await extractText({ buffer, mimeType: DOCX_MIME });
  assert.deepStrictEqual(text.split('\n'), ['Hello world', 'Second paragraph']);
});

test('extracts text from a .pptx buffer, one slide at a time', async () => {
  const buffer = await buildPptxBuffer(['Slide one text', 'Slide two text']);
  const text = await extractText({ buffer, mimeType: PPTX_MIME });
  assert.match(text, /Slide 1/);
  assert.match(text, /Slide one text/);
  assert.match(text, /Slide 2/);
  assert.match(text, /Slide two text/);
});

test('reconstructs the first worksheet of a .xlsx as a tab-separated grid, resolving shared strings', async () => {
  const buffer = await buildXlsxBuffer();
  const text = await extractText({ buffer, mimeType: XLSX_MIME });
  const rows = text.split('\n');
  assert.strictEqual(rows[0], 'Name\tAmount');
  assert.strictEqual(rows[1], 'Alice\t42');
});

test('extracts text from a PDF via an injected pdfParseFn (never a real PDF parser in tests)', async () => {
  const fakePdfParse = async (buffer) => ({ text: `parsed content, ${buffer.length} bytes` });
  const text = await extractText({
    buffer: Buffer.from('fake-pdf-bytes'),
    mimeType: 'application/pdf',
    pdfParseFn: fakePdfParse,
  });
  assert.match(text, /parsed content/);
});

test('extracts text from legacy .doc via an injected docExtractFn (never a real binary fixture in tests)', async () => {
  const fakeDocExtract = async (buffer) => `legacy doc body, ${buffer.length} bytes`;
  const text = await extractText({
    buffer: Buffer.from('fake-doc-bytes'),
    mimeType: 'application/msword',
    docExtractFn: fakeDocExtract,
  });
  assert.match(text, /legacy doc body/);
});

test('extracts text from legacy .xls via an injected xlsExtractFn (never a real binary fixture in tests)', async () => {
  const fakeXlsExtract = async () => 'Name\tAmount\nAlice\t42';
  const text = await extractText({
    buffer: Buffer.from('fake-xls-bytes'),
    mimeType: 'application/vnd.ms-excel',
    xlsExtractFn: fakeXlsExtract,
  });
  assert.strictEqual(text, 'Name\tAmount\nAlice\t42');
});

test('supportsExtraction reports true only for known types', () => {
  assert.strictEqual(supportsExtraction(DOCX_MIME), true);
  assert.strictEqual(supportsExtraction(XLSX_MIME), true);
  assert.strictEqual(supportsExtraction(PPTX_MIME), true);
  assert.strictEqual(supportsExtraction('application/pdf'), true);
  assert.strictEqual(supportsExtraction('application/msword'), true);
  assert.strictEqual(supportsExtraction('application/vnd.ms-excel'), true);
  assert.strictEqual(supportsExtraction('image/png'), false);
});

test('returns null for unsupported mime types instead of throwing', async () => {
  const text = await extractText({ buffer: Buffer.from('x'), mimeType: 'image/png' });
  assert.strictEqual(text, null);
});
