'use strict';

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;

async function embedJpgWithRetry(pdfDoc, logoBuffer, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await pdfDoc.embedJpg(Buffer.from(logoBuffer));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Renders a real invoice PDF (OWM logo, invoice #/date, bill-to, a line-
 * item table, total) and resolves to a Buffer — no temp files, so this
 * plugs straight into mail's base64 attachments.
 *
 * Uses pdf-lib rather than pdfkit: pdfkit's JPEG/PNG image embedding
 * proved genuinely non-deterministic for the real OWM logo (confirmed
 * by generating the identical invoice repeatedly and getting a
 * correctly-colored logo some runs and a corrupted one on others, with
 * no code difference between runs) — a real bug in that library, not
 * something fixable by changing the image format. pdf-lib's image
 * embedding round-tripped correctly on every repeated test.
 */
async function buildInvoicePdf({ invoiceNumber, invoiceDate, billTo, lineItems, logoBuffer }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const gray = rgb(0.33, 0.33, 0.33);

  const marginLeft = 50;
  const marginRight = 50;
  const contentWidth = PAGE_WIDTH - marginLeft - marginRight;
  let y = PAGE_HEIGHT - 50;

  if (logoBuffer) {
    // KNOWN ISSUE (see TODO.md): pdf-lib's embedJpg intermittently throws
    // "SOI not found in JPEG" when called repeatedly in the same long-
    // running process with the same logo bytes - reproduces even with a
    // fresh Buffer copy each call, root cause not yet isolated. A single
    // embed has been reliable in every test; only rapid repeated in-
    // process generation triggers it. Retried rather than left to fail
    // an entire invoice send over a transient library quirk.
    const logoImage = await embedJpgWithRetry(pdfDoc, logoBuffer);
    const logoDrawWidth = 55;
    const logoDrawHeight = logoDrawWidth * (logoImage.height / logoImage.width);
    page.drawImage(logoImage, { x: marginLeft, y: y - logoDrawHeight, width: logoDrawWidth, height: logoDrawHeight });
  }

  page.drawText('One World Montessori', { x: 120, y: y - 14, size: 18, font: boldFont, color: black });
  page.drawText('oneworldmontessori.org', { x: 120, y: y - 30, size: 9, font, color: gray });

  page.drawText('INVOICE', { x: PAGE_WIDTH - marginRight - boldFont.widthOfTextAtSize('INVOICE', 22), y: y - 85, size: 22, font: boldFont, color: black });
  const invLine1 = `Invoice #: ${invoiceNumber}`;
  const invLine2 = `Date: ${invoiceDate}`;
  page.drawText(invLine1, { x: PAGE_WIDTH - marginRight - font.widthOfTextAtSize(invLine1, 10), y: y - 105, size: 10, font, color: black });
  page.drawText(invLine2, { x: PAGE_WIDTH - marginRight - font.widthOfTextAtSize(invLine2, 10), y: y - 118, size: 10, font, color: black });

  y -= 150;
  page.drawText('Bill To:', { x: marginLeft, y, size: 11, font: boldFont, color: black });
  y -= 15;
  page.drawText(billTo, { x: marginLeft, y, size: 10, font, color: black });

  y -= 35;
  const tableTop = y;
  page.drawText('Description', { x: marginLeft, y: tableTop, size: 10, font: boldFont, color: black });
  const amountLabel = 'Amount';
  page.drawText(amountLabel, {
    x: marginLeft + contentWidth - font.widthOfTextAtSize(amountLabel, 10),
    y: tableTop,
    size: 10,
    font: boldFont,
    color: black,
  });
  page.drawLine({ start: { x: marginLeft, y: tableTop - 5 }, end: { x: marginLeft + contentWidth, y: tableTop - 5 }, thickness: 1, color: black });

  let rowY = tableTop - 22;
  let total = 0;
  for (const item of lineItems) {
    page.drawText(item.description, { x: marginLeft, y: rowY, size: 10, font, color: black });
    const amountText = `$${item.amount.toFixed(2)}`;
    page.drawText(amountText, {
      x: marginLeft + contentWidth - font.widthOfTextAtSize(amountText, 10),
      y: rowY,
      size: 10,
      font,
      color: black,
    });
    total += item.amount;
    rowY -= 20;
  }

  page.drawLine({ start: { x: marginLeft, y: rowY - 3 }, end: { x: marginLeft + contentWidth, y: rowY - 3 }, thickness: 1, color: black });
  rowY -= 22;
  page.drawText('Total:', { x: marginLeft + contentWidth - 180, y: rowY, size: 12, font: boldFont, color: black });
  const totalText = `$${total.toFixed(2)}`;
  page.drawText(totalText, {
    x: marginLeft + contentWidth - font.widthOfTextAtSize(totalText, 12),
    y: rowY,
    size: 12,
    font: boldFont,
    color: black,
  });

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

module.exports = { buildInvoicePdf };
