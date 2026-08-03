'use strict';

/**
 * RFC 2047 encoded-word for a header value containing non-ASCII bytes
 * (e.g. an em dash in a subject line) — a raw UTF-8 byte in a header
 * isn't valid RFC 2822, and mail systems that re-decode it under a
 * different assumed charset produce exactly the "Ã¢Â€Â”" mojibake seen
 * in a real sent email before this fix. Pure-ASCII values pass through
 * unchanged.
 */
function encodeHeaderValue(value) {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * Builds a raw RFC 2822 message for Gmail API's users.messages.send
 * `raw` field (base64url-encoded by the caller). Supports plain text
 * and/or HTML bodies plus optional attachments — no external MIME
 * library, this is a small enough format to hand-roll and keep
 * dependency-free.
 */
function buildMimeMessage({ to, cc, subject, text, html, attachments = [], boundary = defaultBoundary() }) {
  const lines = [`To: ${to}`];
  if (cc) lines.push(`Cc: ${Array.isArray(cc) ? cc.join(', ') : cc}`);
  lines.push(`Subject: ${encodeHeaderValue(subject)}`, 'MIME-Version: 1.0');
  const hasAttachments = attachments.length > 0;
  const hasBothBodies = Boolean(text) && Boolean(html);

  if (!hasAttachments && !hasBothBodies) {
    lines.push(
      html ? 'Content-Type: text/html; charset="UTF-8"' : 'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      html ?? text ?? ''
    );
    return lines.join('\r\n');
  }

  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`);

  if (hasBothBodies) {
    const altBoundary = `${boundary}_alt`;
    lines.push(
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      `--${altBoundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      text,
      `--${altBoundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      html,
      `--${altBoundary}--`
    );
  } else {
    lines.push(
      html ? 'Content-Type: text/html; charset="UTF-8"' : 'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      html ?? text ?? ''
    );
  }

  for (const att of attachments) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${att.mimeType}; name="${att.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${att.filename}"`,
      '',
      att.contentBase64
    );
  }
  lines.push(`--${boundary}--`);

  return lines.join('\r\n');
}

/**
 * Builds a genuine "forward as attachment" message: a short intro plus
 * the original message embedded verbatim as a message/rfc822 part (the
 * same shape real mail clients use for "Forward as attachment") — not a
 * generic file attachment, so it carries the original's real headers,
 * formatting, and any of ITS OWN attachments intact. `originalRawBase64Url`
 * is the exact bytes Gmail's own `format: 'raw'` returns for the message
 * being forwarded.
 */
function buildForwardMimeMessage({ to, cc, subject, introText, originalRawBase64Url, boundary = defaultBoundary() }) {
  const lines = [`To: ${to}`];
  if (cc) lines.push(`Cc: ${Array.isArray(cc) ? cc.join(', ') : cc}`);
  lines.push(
    `Subject: ${encodeHeaderValue(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    introText ?? '',
    `--${boundary}`,
    'Content-Type: message/rfc822',
    'Content-Disposition: inline',
    '',
    Buffer.from(originalRawBase64Url, 'base64url').toString('utf8'),
    `--${boundary}--`
  );
  return lines.join('\r\n');
}

function defaultBoundary() {
  return `owm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

module.exports = { buildMimeMessage, buildForwardMimeMessage, encodeHeaderValue };
