'use strict';

const assert = require('node:assert');
const { z } = require('zod');
const { Tool } = require('../core/Tool');
const { getGmailClient } = require('../core/gmailAuth');
const { buildMimeMessage, buildForwardMimeMessage } = require('../core/mime');

function decodeBodyData(bodyData) {
  return Buffer.from(bodyData, 'base64url').toString('utf8');
}

/** Recursively finds a text/plain part's decoded content anywhere in a MIME part tree. */
function findPlainTextPart(part) {
  if (!part) return null;
  if (part.mimeType === 'text/plain' && part.body?.data) return decodeBodyData(part.body.data);
  if (part.parts) {
    for (const child of part.parts) {
      const found = findPlainTextPart(child);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Same walk, but for text/html — only used when no text/plain part exists anywhere. */
function findHtmlPart(part) {
  if (!part) return null;
  if (part.mimeType === 'text/html' && part.body?.data) return decodeBodyData(part.body.data);
  if (part.parts) {
    for (const child of part.parts) {
      const found = findHtmlPart(child);
      if (found !== null) return found;
    }
  }
  return null;
}

function stripHtml(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A simple (non-multipart) message has its content directly on
 * payload.body — but any attachment, or any HTML-formatted reply (the
 * vast majority of real-world email, since most clients send
 * multipart/alternative), nests the actual content inside payload.parts
 * instead, arbitrarily deep for multipart/mixed wrapping
 * multipart/alternative. Regression: reading only payload.body.data
 * silently returned an empty body for exactly these real messages,
 * which then failed interpretReply's required-replyText check.
 */
function extractMessage(data) {
  const headers = data.payload?.headers ?? [];
  const from = headers.find((h) => h.name === 'From')?.value ?? null;
  const subject = headers.find((h) => h.name === 'Subject')?.value ?? null;

  let body = '';
  if (data.payload?.body?.data) {
    body = decodeBodyData(data.payload.body.data);
  } else {
    const plain = findPlainTextPart(data.payload);
    if (plain !== null) {
      body = plain;
    } else {
      const html = findHtmlPart(data.payload);
      if (html !== null) body = stripHtml(html);
    }
  }

  return { id: data.id, threadId: data.threadId, from, subject, body };
}

/**
 * Real Gmail send/read for whichever account authorized it (see
 * gmailAuth.js — identity isn't hardcoded here). `send` covers the
 * outbound half of a job like send-monthly-invoice-email;
 * `listMessages`/`getMessage` cover reading replies back, e.g. so a
 * dispute-resolution flow can find and interpret what came back.
 *
 * DLP guardrail (Seth, explicit requirement): no OWM Drive content may
 * ever leave via email. Every attachment passed to `send` must declare a
 * `source` of either 'rendered' (bytes a rendering tool — pdf/invoice —
 * built fresh from structured params, never fetched from Drive) or
 * 'job-defined' (bytes fixed on the job itself when it was created, see
 * Scheduler.addJob — never something a handler decided to fetch at run
 * time, and never patchable afterward via updateJob). Anything else,
 * including a missing source, is rejected here — this is the one choke
 * point every attachment-carrying send passes through, so the check lives
 * here rather than trusting each caller to have tagged things correctly.
 */
const ALLOWED_ATTACHMENT_SOURCES = new Set(['rendered', 'job-defined']);

function assertAttachmentsAllowed(attachments) {
  for (const attachment of attachments ?? []) {
    if (!ALLOWED_ATTACHMENT_SOURCES.has(attachment.source)) {
      throw new Error(
        `Refusing to send attachment "${attachment.filename}": source must be 'rendered' or 'job-defined', got ${JSON.stringify(
          attachment.source
        )}. Live Drive content may never be attached to an outbound email.`
      );
    }
  }
}
function createMailTool({ secretStore, gmailClientFactory = getGmailClient }) {
  // Keyed by account name (undefined/'default' for the original unnamed
  // account) so more than one Gmail identity (e.g. the shared claude@
  // mailbox plus Seth's own inbox) can be authorized and used side by
  // side without one's consent overwriting the other's cached client.
  const cachedClients = new Map();

  // allowConsent only ever flows through from the explicit 'authorize'
  // action below — never from any other action, so a consent flow can
  // never start as a side effect of a plain send/list/forward call, no
  // matter which process happens to run it (see gmailAuth.js's header
  // for the 2026-08-02 incident this closes).
  async function getClient(account, { allowConsent = false } = {}) {
    const key = account ?? 'default';
    if (!cachedClients.has(key)) {
      cachedClients.set(key, await gmailClientFactory({ secretStore, account, allowConsent }));
    }
    return cachedClients.get(key);
  }

  return new Tool({
    name: 'mail',
    version: '1.5.0',
    description:
      'Real Gmail send/read for whichever account(s) authorized it — sending emails and checking for replies. Pass `account` to target a specific named identity beyond the default. Call `authorize` once per account before anything else.',
    mcpInputSchema: {
      action: z.enum(['authorize', 'send', 'listMessages', 'getMessage', 'getThread', 'whoami', 'forward']).optional(),
      account: z.string().optional(),
      to: z.string().optional(),
      cc: z.union([z.string(), z.array(z.string())]).optional(),
      subject: z.string().optional(),
      text: z.string().optional(),
      html: z.string().optional(),
      introText: z.string().optional(),
      attachments: z
        .array(
          z.object({
            filename: z.string(),
            mimeType: z.string(),
            contentBase64: z.string(),
            source: z.enum(['rendered', 'job-defined']),
          })
        )
        .optional(),
      query: z.string().optional(),
      maxResults: z.number().optional(),
      id: z.string().optional(),
      threadId: z.string().optional(),
    },

    run: async (params) => {
      const action = params?.action ?? 'listMessages';

      // The one and only place a real consent flow may start — a
      // deliberate call naming exactly which account to authorize, never
      // an implicit fallback inside another action.
      if (action === 'authorize') {
        const client = await getClient(params?.account, { allowConsent: true });
        const res = await client.users.getProfile({ userId: 'me' });
        return { authorized: true, emailAddress: res.data.emailAddress };
      }

      const client = await getClient(params?.account);

      if (action === 'send') {
        if (!params.to) throw new Error('send requires to');
        if (!params.subject) throw new Error('send requires subject');
        assertAttachmentsAllowed(params.attachments);
        const raw = Buffer.from(
          buildMimeMessage({
            to: params.to,
            cc: params.cc,
            subject: params.subject,
            text: params.text,
            html: params.html,
            attachments: params.attachments,
          }),
          'utf8'
        ).toString('base64url');
        const requestBody = params.threadId ? { raw, threadId: params.threadId } : { raw };
        const res = await client.users.messages.send({ userId: 'me', requestBody });
        return { sent: true, id: res.data.id, threadId: res.data.threadId };
      }

      if (action === 'listMessages') {
        const res = await client.users.messages.list({
          userId: 'me',
          q: params.query ?? '',
          maxResults: params.maxResults ?? 20,
        });
        return { messages: (res.data.messages ?? []).map((m) => ({ id: m.id, threadId: m.threadId })) };
      }

      if (action === 'getMessage') {
        if (!params.id) throw new Error('getMessage requires id');
        const res = await client.users.messages.get({ userId: 'me', id: params.id, format: 'full' });
        return { message: extractMessage(res.data) };
      }

      if (action === 'getThread') {
        if (!params.id) throw new Error('getThread requires id');
        const res = await client.users.threads.get({ userId: 'me', id: params.id, format: 'full' });
        return { threadId: res.data.id, messages: (res.data.messages ?? []).map(extractMessage) };
      }

      if (action === 'whoami') {
        const res = await client.users.getProfile({ userId: 'me' });
        return { emailAddress: res.data.emailAddress };
      }

      if (action === 'forward') {
        if (!params.id) throw new Error('forward requires id');
        if (!params.to) throw new Error('forward requires to');
        const res = await client.users.messages.get({ userId: 'me', id: params.id, format: 'raw' });
        const originalRawBase64Url = res.data.raw;
        const decoded = Buffer.from(originalRawBase64Url, 'base64url').toString('utf8');
        const originalSubjectMatch = decoded.match(/^Subject:\s*(.+)$/im);
        const originalSubject = originalSubjectMatch ? originalSubjectMatch[1].trim() : '(no subject)';
        const subject = params.subject ?? `Fwd: ${originalSubject}`;

        const raw = Buffer.from(
          buildForwardMimeMessage({
            to: params.to,
            cc: params.cc,
            subject,
            introText: params.introText,
            originalRawBase64Url,
          }),
          'utf8'
        ).toString('base64url');
        const requestBody = params.threadId ? { raw, threadId: params.threadId } : { raw };
        const sendRes = await client.users.messages.send({ userId: 'me', requestBody });
        return { sent: true, id: sendRes.data.id, threadId: sendRes.data.threadId, forwardedSubject: originalSubject };
      }

      throw new Error(`Unknown mail action: ${action}`);
    },

    // Never touches real Gmail — a fake client proves the send/list/get
    // wiring and the MIME-attachment shape.
    internalTest: async () => {
      const sentRawMessages = [];
      const fakeMessages = {
        'msg-1': {
          id: 'msg-1',
          threadId: 'thread-1',
          payload: {
            headers: [
              { name: 'From', value: 'businessmanager@oneworldmontessori.org' },
              { name: 'Subject', value: 'Re: Monthly invoice' },
            ],
            body: { data: Buffer.from('Looks correct, approved.', 'utf8').toString('base64url') },
          },
        },
        // Regression: a real reply with an attachment (or sent from any
        // client that sends multipart/alternative, i.e. almost everyone)
        // nests the actual text several levels deep instead of putting it
        // on payload.body directly — previously silently extracted as ''.
        'msg-multipart-plain': {
          id: 'msg-multipart-plain',
          threadId: 'thread-2',
          payload: {
            headers: [{ name: 'From', value: 'businessmanager@oneworldmontessori.org' }],
            mimeType: 'multipart/mixed',
            parts: [
              {
                mimeType: 'multipart/alternative',
                parts: [
                  { mimeType: 'text/plain', body: { data: Buffer.from('This has the wrong email, please fix.', 'utf8').toString('base64url') } },
                  { mimeType: 'text/html', body: { data: Buffer.from('<p>This has the wrong email, please fix.</p>', 'utf8').toString('base64url') } },
                ],
              },
              { mimeType: 'application/pdf', body: { attachmentId: 'att-1' } },
            ],
          },
        },
        // Regression: no text/plain part anywhere (HTML-only reply) must
        // still produce readable text, not an empty body.
        'msg-multipart-html-only': {
          id: 'msg-multipart-html-only',
          threadId: 'thread-3',
          payload: {
            headers: [{ name: 'From', value: 'businessmanager@oneworldmontessori.org' }],
            mimeType: 'multipart/alternative',
            parts: [{ mimeType: 'text/html', body: { data: Buffer.from('<p>Approved, <b>thanks</b>!</p>', 'utf8').toString('base64url') } }],
          },
        },
      };
      const sendRequestBodies = [];
      const fakeClient = {
        users: {
          messages: {
            send: async ({ requestBody }) => {
              sentRawMessages.push(requestBody.raw);
              sendRequestBodies.push(requestBody);
              return { data: { id: 'sent-1', threadId: 'thread-1' } };
            },
            list: async () => ({ data: { messages: [{ id: 'msg-1', threadId: 'thread-1' }] } }),
            get: async ({ id, format }) => {
              if (format === 'raw' && id === 'msg-to-forward') {
                const rawOriginal =
                  'From: invoice+statements@mail.anthropic.com\r\nSubject: Your receipt from Anthropic, PBC #1234\r\n\r\nReceipt body here.';
                return { data: { raw: Buffer.from(rawOriginal, 'utf8').toString('base64url') } };
              }
              return { data: fakeMessages[id] };
            },
          },
          threads: {
            get: async ({ id }) => ({ data: { id, messages: [fakeMessages['msg-1']] } }),
          },
          getProfile: async () => ({ data: { emailAddress: 'claude@oneworldmontessori.org' } }),
        },
      };
      const factoryCalls = [];
      const fakeTool = createMailTool({
        secretStore: { get: () => null, set: () => {} },
        gmailClientFactory: async ({ account, allowConsent }) => {
          factoryCalls.push({ account, allowConsent });
          return {
            ...fakeClient,
            users: {
              ...fakeClient.users,
              getProfile: async () => ({ data: { emailAddress: account ? `${account}@oneworldmontessori.org` : 'claude@oneworldmontessori.org' } }),
            },
          };
        },
      });

      const sent = await fakeTool.invoke({
        action: 'send',
        to: 'businessmanager@oneworldmontessori.org',
        subject: 'Monthly invoice',
        text: 'See attached.',
        attachments: [
          {
            filename: 'invoice.pdf',
            mimeType: 'application/pdf',
            contentBase64: Buffer.from('fake pdf bytes').toString('base64'),
            source: 'rendered',
          },
        ],
      });
      assert.strictEqual(sent.result.sent, true);
      assert.strictEqual(sentRawMessages.length, 1);
      const decodedRaw = Buffer.from(sentRawMessages[0], 'base64url').toString('utf8');
      assert.match(decodedRaw, /Content-Disposition: attachment; filename="invoice\.pdf"/);
      assert.match(decodedRaw, /To: businessmanager@oneworldmontessori\.org/);
      assert.strictEqual(sendRequestBodies[0].threadId, undefined, 'no threadId means a fresh message, not a reply');

      const reply = await fakeTool.invoke({
        action: 'send',
        to: 'businessmanager@oneworldmontessori.org',
        subject: 'Re: Monthly invoice',
        text: 'Following up.',
        threadId: 'thread-1',
      });
      assert.strictEqual(reply.result.sent, true);
      assert.strictEqual(sendRequestBodies[1].threadId, 'thread-1', 'a reply must be sent into the existing thread');

      const listed = await fakeTool.invoke({ action: 'listMessages', query: 'is:unread' });
      assert.strictEqual(listed.result.messages.length, 1);
      assert.strictEqual(listed.result.messages[0].id, 'msg-1');

      const fetched = await fakeTool.invoke({ action: 'getMessage', id: 'msg-1' });
      assert.strictEqual(fetched.result.message.from, 'businessmanager@oneworldmontessori.org');
      assert.match(fetched.result.message.body, /approved/);

      const thread = await fakeTool.invoke({ action: 'getThread', id: 'thread-1' });
      assert.strictEqual(thread.result.messages.length, 1);
      assert.strictEqual(thread.result.messages[0].from, 'businessmanager@oneworldmontessori.org');

      const who = await fakeTool.invoke({ action: 'whoami' });
      assert.strictEqual(who.result.emailAddress, 'claude@oneworldmontessori.org');

      const multipartPlain = await fakeTool.invoke({ action: 'getMessage', id: 'msg-multipart-plain' });
      assert.strictEqual(
        multipartPlain.result.message.body,
        'This has the wrong email, please fix.',
        'must find the nested text/plain part several levels deep, not the pdf attachment part, and not come back empty'
      );

      const htmlOnly = await fakeTool.invoke({ action: 'getMessage', id: 'msg-multipart-html-only' });
      assert.match(
        htmlOnly.result.message.body,
        /Approved.*thanks/,
        'must fall back to text/html with tags stripped when no text/plain part exists anywhere'
      );

      // DLP guardrail: send must refuse any attachment that isn't tagged as
      // either rendered (built fresh by a rendering tool) or job-defined
      // (fixed on the job at creation) — this is the one enforcement point
      // every attachment-carrying send passes through.
      await assert.rejects(
        () =>
          fakeTool.invoke({
            action: 'send',
            to: 'a@b.com',
            subject: 'No source tag',
            attachments: [{ filename: 'x.pdf', mimeType: 'application/pdf', contentBase64: 'abc' }],
          }),
        /Refusing to send attachment/,
        'an attachment with no source tag must be rejected'
      );

      await assert.rejects(
        () =>
          fakeTool.invoke({
            action: 'send',
            to: 'a@b.com',
            subject: 'Drive-sourced attachment',
            attachments: [{ filename: 'x.pdf', mimeType: 'application/pdf', contentBase64: 'abc', source: 'drive' }],
          }),
        /Refusing to send attachment/,
        'an attachment claiming to come straight from Drive must be rejected, not just an untagged one'
      );

      const jobDefinedSend = await fakeTool.invoke({
        action: 'send',
        to: 'a@b.com',
        subject: 'Job-defined attachment',
        attachments: [{ filename: 'contract.pdf', mimeType: 'application/pdf', contentBase64: 'abc', source: 'job-defined' }],
      });
      assert.strictEqual(jobDefinedSend.result.sent, true, 'job-defined attachments are allowed through');

      // forward: a genuine "forward as attachment" (a base64 message/rfc822
      // .eml file, not literal inline text — see mime.js's header for why:
      // Gmail's own send API silently drops nested attachments from a
      // literal-text message/rfc822 part) - defaults the subject from the
      // original, and the original survives byte-for-byte once decoded.
      const forwarded = await fakeTool.invoke({
        action: 'forward',
        id: 'msg-to-forward',
        to: 'johanna@oneworldmontessori.org',
        introText: 'Forwarding along.',
      });
      assert.strictEqual(forwarded.result.sent, true);
      assert.strictEqual(forwarded.result.forwardedSubject, 'Your receipt from Anthropic, PBC #1234');
      const forwardedRaw = Buffer.from(sentRawMessages[sentRawMessages.length - 1], 'base64url').toString('utf8');
      assert.match(forwardedRaw, /Subject: Fwd: Your receipt from Anthropic, PBC #1234/);
      assert.match(forwardedRaw, /Content-Type: message\/rfc822; name="original-message\.eml"/);
      assert.match(forwardedRaw, /Content-Transfer-Encoding: base64/);
      assert.doesNotMatch(forwardedRaw, /Receipt body here\./, 'the original must be opaque base64, never literal text, in what actually gets sent');
      const eml = forwardedRaw.split('Content-Disposition: attachment; filename="original-message.eml"\r\n\r\n')[1].split(/\r\n--/)[0];
      const decodedOriginal = Buffer.from(eml.replace(/\r\n/g, ''), 'base64').toString('utf8');
      assert.match(decodedOriginal, /Receipt body here\./, 'the original message content must survive byte-for-byte once decoded back out');
      assert.match(forwardedRaw, /Forwarding along\./);

      // Multi-account: a named account gets its own client, cached
      // separately, without disturbing the default account's client.
      const defaultWho = await fakeTool.invoke({ action: 'whoami' });
      assert.strictEqual(defaultWho.result.emailAddress, 'claude@oneworldmontessori.org');
      const sethWho = await fakeTool.invoke({ action: 'whoami', account: 'seth' });
      assert.strictEqual(sethWho.result.emailAddress, 'seth@oneworldmontessori.org');
      await fakeTool.invoke({ action: 'whoami' });
      await fakeTool.invoke({ action: 'whoami', account: 'seth' });
      assert.deepStrictEqual(
        factoryCalls,
        [
          { account: undefined, allowConsent: false },
          { account: 'seth', allowConsent: false },
        ],
        'each distinct account must only build its client once (cached thereafter), and the default/named accounts must not collide'
      );

      // authorize: the one and only action allowed to request a live
      // consent flow (regression: 2026-08-02 — an ordinary listMessages
      // call against an unauthorized account silently popped a real
      // browser consent screen). Every other action above must have
      // requested allowConsent: false, which the assertion just above
      // already confirms.
      const authorized = await fakeTool.invoke({ action: 'authorize', account: 'newacct' });
      assert.strictEqual(authorized.result.authorized, true);
      assert.strictEqual(authorized.result.emailAddress, 'newacct@oneworldmontessori.org');
      assert.deepStrictEqual(
        factoryCalls.at(-1),
        { account: 'newacct', allowConsent: true },
        'authorize must be the only action that ever requests allowConsent: true'
      );

      return { passed: true };
    },

    realWorldTest: async (testConfig, { call }) => {
      if (!testConfig.to) {
        return { passed: true, skipped: true, reason: 'testConfig.to not provided — skipping real Gmail send' };
      }
      const { result } = await call({ action: 'send', to: testConfig.to, subject: 'OWM mail tool real-world test', text: 'ok' });
      assert.strictEqual(result.sent, true);
      return { passed: true, checkedAgainst: testConfig.label ?? 'unnamed-fixture' };
    },
  });
}

module.exports = { createMailTool };
