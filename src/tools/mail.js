'use strict';

const assert = require('node:assert');
const { z } = require('zod');
const { Tool } = require('../core/Tool');
const { getGmailClient } = require('../core/gmailAuth');
const { buildMimeMessage } = require('../core/mime');

function extractMessage(data) {
  const headers = data.payload?.headers ?? [];
  const from = headers.find((h) => h.name === 'From')?.value ?? null;
  const subject = headers.find((h) => h.name === 'Subject')?.value ?? null;
  const bodyData = data.payload?.body?.data;
  const body = bodyData ? Buffer.from(bodyData, 'base64url').toString('utf8') : '';
  return { id: data.id, threadId: data.threadId, from, subject, body };
}

/**
 * Real Gmail send/read for whichever account authorized it (see
 * gmailAuth.js — identity isn't hardcoded here). `send` covers the
 * outbound half of a job like send-monthly-invoice-email;
 * `listMessages`/`getMessage` cover reading replies back, e.g. so a
 * dispute-resolution flow can find and interpret what came back.
 */
function createMailTool({ secretStore, gmailClientFactory = getGmailClient }) {
  let cachedClient = null;

  return new Tool({
    name: 'mail',
    version: '1.0.0',
    description: 'Real Gmail send/read for the account that authorized it — sending emails and checking for replies.',
    mcpInputSchema: {
      action: z.enum(['send', 'listMessages', 'getMessage']).optional(),
      to: z.string().optional(),
      cc: z.union([z.string(), z.array(z.string())]).optional(),
      subject: z.string().optional(),
      text: z.string().optional(),
      html: z.string().optional(),
      attachments: z
        .array(z.object({ filename: z.string(), mimeType: z.string(), contentBase64: z.string() }))
        .optional(),
      query: z.string().optional(),
      maxResults: z.number().optional(),
      id: z.string().optional(),
      threadId: z.string().optional(),
    },

    run: async (params) => {
      const action = params?.action ?? 'listMessages';

      if (!cachedClient) {
        cachedClient = await gmailClientFactory({ secretStore });
      }

      if (action === 'send') {
        if (!params.to) throw new Error('send requires to');
        if (!params.subject) throw new Error('send requires subject');
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
        const res = await cachedClient.users.messages.send({ userId: 'me', requestBody });
        return { sent: true, id: res.data.id, threadId: res.data.threadId };
      }

      if (action === 'listMessages') {
        const res = await cachedClient.users.messages.list({
          userId: 'me',
          q: params.query ?? '',
          maxResults: params.maxResults ?? 20,
        });
        return { messages: (res.data.messages ?? []).map((m) => ({ id: m.id, threadId: m.threadId })) };
      }

      if (action === 'getMessage') {
        if (!params.id) throw new Error('getMessage requires id');
        const res = await cachedClient.users.messages.get({ userId: 'me', id: params.id, format: 'full' });
        return { message: extractMessage(res.data) };
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
            get: async ({ id }) => ({ data: fakeMessages[id] }),
          },
        },
      };
      const fakeTool = createMailTool({
        secretStore: { get: () => null, set: () => {} },
        gmailClientFactory: async () => fakeClient,
      });

      const sent = await fakeTool.invoke({
        action: 'send',
        to: 'businessmanager@oneworldmontessori.org',
        subject: 'Monthly invoice',
        text: 'See attached.',
        attachments: [
          { filename: 'invoice.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('fake pdf bytes').toString('base64') },
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
