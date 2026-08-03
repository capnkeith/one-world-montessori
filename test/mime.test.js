'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildMimeMessage, buildForwardMimeMessage, encodeHeaderValue } = require('../src/core/mime');

test('a plain-text-only message has no multipart wrapper', () => {
  const raw = buildMimeMessage({ to: 'a@b.com', subject: 'Hi', text: 'hello there' });
  assert.match(raw, /^To: a@b\.com/);
  assert.match(raw, /Content-Type: text\/plain/);
  assert.doesNotMatch(raw, /multipart/);
  assert.match(raw, /hello there/);
});

test('an html-only message uses text\\/html content type', () => {
  const raw = buildMimeMessage({ to: 'a@b.com', subject: 'Hi', html: '<b>hello</b>' });
  assert.match(raw, /Content-Type: text\/html/);
  assert.match(raw, /<b>hello<\/b>/);
});

test('a message with both text and html wraps them in multipart/alternative', () => {
  const raw = buildMimeMessage({ to: 'a@b.com', subject: 'Hi', text: 'plain version', html: '<b>html version</b>' });
  assert.match(raw, /multipart\/alternative/);
  assert.match(raw, /plain version/);
  assert.match(raw, /<b>html version<\/b>/);
});

test('an attachment is included as a base64 part with a Content-Disposition filename', () => {
  const raw = buildMimeMessage({
    to: 'a@b.com',
    subject: 'Invoice',
    text: 'See attached.',
    attachments: [{ filename: 'invoice.pdf', mimeType: 'application/pdf', contentBase64: 'ZmFrZS1wZGY=' }],
  });
  assert.match(raw, /multipart\/mixed/);
  assert.match(raw, /Content-Type: application\/pdf; name="invoice\.pdf"/);
  assert.match(raw, /Content-Disposition: attachment; filename="invoice\.pdf"/);
  assert.match(raw, /ZmFrZS1wZGY=/);
});

test('multiple attachments each get their own part', () => {
  const raw = buildMimeMessage({
    to: 'a@b.com',
    subject: 'Two files',
    text: 'body',
    attachments: [
      { filename: 'one.pdf', mimeType: 'application/pdf', contentBase64: 'AAA' },
      { filename: 'two.png', mimeType: 'image/png', contentBase64: 'BBB' },
    ],
  });
  assert.match(raw, /filename="one\.pdf"/);
  assert.match(raw, /filename="two\.png"/);
});

test('cc accepts a single address or an array, joined with commas', () => {
  const single = buildMimeMessage({ to: 'a@b.com', cc: 'c@d.com', subject: 'Hi', text: 'body' });
  assert.match(single, /^Cc: c@d\.com$/m);

  const multiple = buildMimeMessage({ to: 'a@b.com', cc: ['c@d.com', 'e@f.com'], subject: 'Hi', text: 'body' });
  assert.match(multiple, /^Cc: c@d\.com, e@f\.com$/m);
});

test('omitting cc leaves no Cc header at all', () => {
  const raw = buildMimeMessage({ to: 'a@b.com', subject: 'Hi', text: 'body' });
  assert.doesNotMatch(raw, /^Cc:/m);
});

test('encodeHeaderValue leaves pure-ASCII values untouched', () => {
  assert.strictEqual(encodeHeaderValue('Monthly invoice'), 'Monthly invoice');
});

test('encodeHeaderValue RFC-2047-encodes a value containing non-ASCII bytes', () => {
  const encoded = encodeHeaderValue('Thank you — and love the logo, Rebecca!');
  assert.match(encoded, /^=\?UTF-8\?B\?.+\?=$/);
  const decoded = Buffer.from(encoded.slice('=?UTF-8?B?'.length, -'?='.length), 'base64').toString('utf8');
  assert.strictEqual(decoded, 'Thank you — and love the logo, Rebecca!');
});

test('a subject with an em dash is not sent as raw UTF-8 bytes in the header (regression: real mojibake sent 2026-08-01)', () => {
  const raw = buildMimeMessage({ to: 'a@b.com', subject: 'Thank you — and love the logo, Rebecca!', text: 'body' });
  assert.doesNotMatch(raw, /^Subject: .*—/m, 'a raw em dash in the Subject header is exactly the bug this regresses');
  assert.match(raw, /^Subject: =\?UTF-8\?B\?/m);
});

test('bodies declare Content-Transfer-Encoding: 8bit so UTF-8 body bytes are valid, not just headers', () => {
  const raw = buildMimeMessage({ to: 'a@b.com', subject: 'Hi', text: 'em dash — here' });
  assert.match(raw, /Content-Transfer-Encoding: 8bit/);
});

test('a custom boundary is used verbatim instead of a random one, for deterministic output', () => {
  const raw = buildMimeMessage({
    to: 'a@b.com',
    subject: 'Hi',
    text: 'body',
    attachments: [{ filename: 'f.txt', mimeType: 'text/plain', contentBase64: 'AAA' }],
    boundary: 'fixed-boundary-123',
  });
  assert.match(raw, /boundary="fixed-boundary-123"/);
  assert.match(raw, /--fixed-boundary-123--/);
});

test('buildForwardMimeMessage embeds the original as a real message/rfc822 part, not a generic attachment', () => {
  const originalRaw = 'From: someone@example.com\r\nSubject: Original subject\r\n\r\nOriginal body text.';
  const raw = buildForwardMimeMessage({
    to: 'johanna@oneworldmontessori.org',
    cc: 'seth@oneworldmontessori.org',
    subject: 'Fwd: Original subject',
    introText: 'Forwarding this along.',
    originalRawBase64Url: Buffer.from(originalRaw, 'utf8').toString('base64url'),
    boundary: 'fixed-boundary',
  });

  assert.match(raw, /^To: johanna@oneworldmontessori\.org/);
  assert.match(raw, /^Cc: seth@oneworldmontessori\.org/m);
  assert.match(raw, /Content-Type: message\/rfc822/);
  assert.match(raw, /Content-Disposition: inline/);
  assert.match(raw, /Forwarding this along\./);
  // The original message's own headers/body must appear verbatim, not re-encoded as base64 attachment bytes.
  assert.match(raw, /From: someone@example\.com/);
  assert.match(raw, /Subject: Original subject/);
  assert.match(raw, /Original body text\./);
  assert.doesNotMatch(raw, /Content-Disposition: attachment/, 'a forward is not a generic file attachment');
});
