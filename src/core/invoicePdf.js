'use strict';

const PDFDocument = require('pdfkit');

/**
 * Renders a real invoice PDF (OWM logo, invoice #/date, bill-to, a line-
 * item table, total) and resolves to a Buffer — no temp files, so this
 * plugs straight into mail's base64 attachments.
 */
function buildInvoicePdf({ invoiceNumber, invoiceDate, billTo, lineItems, logoBuffer }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    if (logoBuffer) {
      doc.image(logoBuffer, 50, 45, { width: 55 });
    }
    doc.fontSize(18).text('One World Montessori', 120, 50);
    doc.fontSize(9).fillColor('#555').text('oneworldmontessori.org', 120, 72);
    doc.fillColor('#000');

    doc.fontSize(22).text('INVOICE', 50, 130, { align: 'right' });
    doc.fontSize(10)
      .text(`Invoice #: ${invoiceNumber}`, { align: 'right' })
      .text(`Date: ${invoiceDate}`, { align: 'right' });

    doc.moveDown(2);
    doc.fontSize(11).text('Bill To:', 50);
    doc.fontSize(10).text(billTo, 50, doc.y, { width: 300 });

    doc.moveDown(2);
    const tableTop = doc.y;
    doc.fontSize(10).text('Description', 50, tableTop, { width: 350 });
    doc.text('Amount', 420, tableTop, { width: 100, align: 'right' });
    doc.moveTo(50, tableTop + 15).lineTo(520, tableTop + 15).stroke();

    let y = tableTop + 22;
    let total = 0;
    for (const item of lineItems) {
      doc.fontSize(10).text(item.description, 50, y, { width: 350 });
      doc.text(`$${item.amount.toFixed(2)}`, 420, y, { width: 100, align: 'right' });
      total += item.amount;
      y += 20;
    }

    doc.moveTo(50, y + 5).lineTo(520, y + 5).stroke();
    doc.fontSize(12).text('Total:', 320, y + 15, { width: 100 });
    doc.text(`$${total.toFixed(2)}`, 420, y + 15, { width: 100, align: 'right' });

    doc.end();
  });
}

module.exports = { buildInvoicePdf };
