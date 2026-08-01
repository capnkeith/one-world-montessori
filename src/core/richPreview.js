'use strict';

const path = require('node:path');

/**
 * "Rich" (full-fidelity) preview rendering — mammoth converts .docx to
 * real HTML (headings/bold/lists), pdfjs-dist + @napi-rs/canvas rasterize
 * PDF pages to PNGs, so previews actually look like the source document
 * instead of the plain-text extraction in textExtract.js. This is
 * deliberately a separate, slower tier: the drive tool's `getContent`
 * action (fast, plain-text) stays as the immediate preview; callers ask
 * for this one (`getRichContent`) as a background upgrade — see
 * sample-app/index.html's two-tier preview loader.
 *
 * pdfjs-dist and @napi-rs/canvas are pinned to EXACT versions in
 * package.json (5.4.296 / 0.1.80) matching what pdf-parse (used by
 * textExtract.js's fast-tier PDF extraction) bundles internally. This
 * isn't cosmetic: pdfjs-dist has a runtime version guard that throws
 * "API version X does not match Worker version Y" if two different
 * pdfjs-dist copies end up loaded in the same process, and a version
 * skew between our @napi-rs/canvas and the one pdfjs-dist's rendering
 * code expects corrupts shared native (Rust/napi) state and produces
 * bizarre CanvasGraphics errors — both only reproduce after the fast
 * tier has *also* run in that same long-lived server process (pdf-parse
 * loads its own nested copies first), so an isolated single-shot test of
 * just this module won't catch a version drift. Don't loosen these two
 * to caret ranges without re-verifying getContent then getRichContent
 * back-to-back in one running server process.
 */

const RICH_PREVIEW_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/pdf',
]);

function supportsRichPreview(mimeType) {
  return RICH_PREVIEW_MIME_TYPES.has(mimeType);
}

async function renderDocxRich(buffer) {
  const mammoth = require('mammoth');
  const { value: html } = await mammoth.convertToHtml({ buffer });
  return { type: 'html', html };
}

// pdfjs-dist ships its standard-14 font metrics as data files; without
// pointing it at them explicitly it can't lay out non-embedded standard
// fonts (Helvetica, Times, etc. — the overwhelming majority of real PDFs)
// and falls back to a broken-looking, warning-spewing default. This must
// be a plain forward-slash path, NOT a file:// URL — pdfjs-dist's Node
// font loader fetches file:// URLs and Node's fetch doesn't support that
// scheme, so a file:// URL here fails with "Unable to load font data".
function standardFontDataUrl() {
  const pdfjsPkgDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
  return (path.join(pdfjsPkgDir, 'standard_fonts') + path.sep).split(path.sep).join('/');
}

// Caps page count so a huge PDF can't turn one preview request into
// minutes of rendering + tens of embedded page images.
async function renderPdfRich(buffer, { maxPages = 20, scale = 1.5 } = {}) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = require('@napi-rs/canvas');

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: standardFontDataUrl(),
    disableFontFace: true,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;

  try {
    const pageCount = Math.min(pdf.numPages, maxPages);
    const pageImages = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i);
      try {
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        pageImages.push(canvas.toBuffer('image/png').toString('base64'));
      } finally {
        page.cleanup();
      }
    }
    return { type: 'pages', pageImages, totalPages: pdf.numPages, truncated: pdf.numPages > maxPages };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** Returns null if mimeType isn't one we know how to richly render. */
async function renderRichPreview(buffer, mimeType) {
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return renderDocxRich(buffer);
  }
  if (mimeType === 'application/pdf') {
    return renderPdfRich(buffer);
  }
  return null;
}

module.exports = { supportsRichPreview, renderRichPreview };
