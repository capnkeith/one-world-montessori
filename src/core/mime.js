'use strict';

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
  lines.push(`Subject: ${subject}`, 'MIME-Version: 1.0');
  const hasAttachments = attachments.length > 0;
  const hasBothBodies = Boolean(text) && Boolean(html);

  if (!hasAttachments && !hasBothBodies) {
    lines.push(html ? 'Content-Type: text/html; charset="UTF-8"' : 'Content-Type: text/plain; charset="UTF-8"');
    lines.push('');
    lines.push(html ?? text ?? '');
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
      '',
      text,
      `--${altBoundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      '',
      html,
      `--${altBoundary}--`
    );
  } else {
    lines.push(html ? 'Content-Type: text/html; charset="UTF-8"' : 'Content-Type: text/plain; charset="UTF-8"', '', html ?? text ?? '');
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

function defaultBoundary() {
  return `owm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

module.exports = { buildMimeMessage };
