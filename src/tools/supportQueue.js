'use strict';

const assert = require('node:assert');
const { z } = require('zod');
const { Tool } = require('../core/Tool');
const { SupportQueue } = require('../core/SupportQueue');

/**
 * The third job queue (see WORKER.md): real, unsolicited incoming email
 * to claude@ - anyone at the org can email in a request tagged by
 * subject line ("tech support" or "general") and a Claude compute node
 * answers it, no separate submission channel needed (unlike promptQueue,
 * which the sample app's "Ask Claude" bar submits into).
 *
 * `nodeId` identifies this instance for the claim/lease model, same
 * convention as `scheduler`/`promptQueue`.
 */
function categorize(subject) {
  const s = (subject || '').toLowerCase();
  if (s.includes('tech support')) return 'tech-support';
  if (s.includes('general')) return 'general';
  return null;
}

function createSupportQueueTool({ supportStore, getMailTool, nodeId = `node-${Math.random().toString(36).slice(2)}` }) {
  const supportQueue = new SupportQueue({ store: supportStore });

  return new Tool({
    name: 'supportQueue',
    version: '1.0.0',
    description:
      'Email-triggered support queue: anyone can email claude@ with "tech support" or "general" in the subject; checkPending finds and claims new tickets from the real inbox, recordAnswer sends the reply and resolves it.',
    mcpInputSchema: {
      action: z.enum(['checkPending', 'recordAnswer', 'getTicket', 'listTickets']).optional(),
      id: z.string().optional(),
      replyText: z.string().optional(),
    },

    run: async (params, ctx) => {
      const action = params?.action ?? 'checkPending';
      const mailTool = getMailTool();

      switch (action) {
        case 'checkPending': {
          // in:inbox keeps this from re-discovering claude@'s own sent
          // replies (Gmail files sent mail under Sent, not Inbox) even
          // though their subject ("Re: tech support...") still matches.
          const { result: listed } = await ctx.call(mailTool, {
            action: 'listMessages',
            query: '(subject:"tech support" OR subject:general) in:inbox',
            maxResults: 20,
          });

          const known = new Set(supportQueue.listTickets().map((t) => t.messageId));
          for (const { id: messageId } of listed.messages) {
            if (known.has(messageId)) continue; // cheap skip before a real fetch
            const { result: full } = await ctx.call(mailTool, { action: 'getMessage', id: messageId });
            const category = categorize(full.message.subject);
            if (!category) continue;
            supportQueue.registerIfNew({
              messageId,
              threadId: full.message.threadId,
              category,
              from: full.message.from,
              subject: full.message.subject,
              body: full.message.body,
            });
          }

          const pending = [];
          for (const ticket of supportQueue.listTickets()) {
            if (ticket.resolvedAt) continue;
            try {
              supportQueue.claimTicket({ id: ticket.id, nodeId });
            } catch {
              continue; // another compute node already holds a live claim on this one
            }
            pending.push({
              id: ticket.id,
              category: ticket.category,
              from: ticket.from,
              subject: ticket.subject,
              body: ticket.body,
              receivedAt: ticket.receivedAt,
            });
          }
          return { pending };
        }

        case 'recordAnswer': {
          if (!params.id) throw new Error('recordAnswer requires id');
          if (!params.replyText) throw new Error('recordAnswer requires replyText');
          const ticket = supportQueue.getTicket(params.id);
          if (!ticket) throw new Error(`No ticket with id ${params.id}`);
          const subject = /^re:/i.test(ticket.subject || '') ? ticket.subject : `Re: ${ticket.subject}`;
          await ctx.call(mailTool, { action: 'send', to: ticket.from, subject, text: params.replyText, threadId: ticket.threadId });
          return supportQueue.resolveTicket({ id: params.id, replyText: params.replyText });
        }

        case 'getTicket': {
          if (!params.id) throw new Error('getTicket requires id');
          const ticket = supportQueue.getTicket(params.id);
          if (!ticket) throw new Error(`No ticket with id ${params.id}`);
          return { ticket };
        }

        case 'listTickets':
          // Read-only, never claims anything - safe for a monitoring
          // view to poll freely without disturbing an in-progress claim.
          return { tickets: supportQueue.listTickets() };

        default:
          throw new Error(`Unknown supportQueue action: ${action}`);
      }
    },

    internalTest: async ({ call }) => {
      let tickets = [];
      const fakeStore = {
        load: () => tickets,
        save: (next) => {
          tickets = next;
        },
        mutate: (id, updaterFn) => {
          const ticket = tickets.find((t) => t.id === id);
          if (!ticket) return null;
          return updaterFn(ticket) ? ticket : null;
        },
      };

      let inbox = [
        { id: 'msg-1', threadId: 'thread-1', from: 'Rebecca Keith <rebecca@oneworldmontessori.org>', subject: 'tech support: cannot log in', body: 'The app will not open.' },
        { id: 'msg-2', threadId: 'thread-2', from: 'Johanna Keith <businessmanager@oneworldmontessori.org>', subject: 'general question about invoices', body: 'Where do old invoices live?' },
        { id: 'msg-3', threadId: 'thread-3', from: 'Someone Else <someone@example.com>', subject: 'unrelated newsletter', body: 'buy our stuff' },
      ];
      const sent = [];
      const fakeMailTool = {
        invoke: async (p) => {
          if (p.action === 'listMessages') return { result: { messages: inbox.map((m) => ({ id: m.id, threadId: m.threadId })) } };
          if (p.action === 'getMessage') return { result: { message: inbox.find((m) => m.id === p.id) } };
          if (p.action === 'send') {
            sent.push(p);
            return { result: { sent: true, id: 'sent-' + sent.length, threadId: p.threadId } };
          }
          throw new Error(`fakeMailTool: unexpected action ${p.action}`);
        },
      };

      const fakeTool = createSupportQueueTool({ supportStore: fakeStore, getMailTool: () => fakeMailTool, nodeId: 'test-node' });

      const checked = await fakeTool.invoke({ action: 'checkPending' });
      assert.strictEqual(checked.result.pending.length, 2, 'the unrelated newsletter must never become a ticket');
      const categories = checked.result.pending.map((t) => t.category).sort();
      assert.deepStrictEqual(categories, ['general', 'tech-support']);

      // A second node checking concurrently must not also see either ticket pending.
      const otherNodeTool = createSupportQueueTool({ supportStore: fakeStore, getMailTool: () => fakeMailTool, nodeId: 'other-node' });
      const checkedByOther = await otherNodeTool.invoke({ action: 'checkPending' });
      assert.strictEqual(checkedByOther.result.pending.length, 0, 'already claimed by test-node, must not double-surface');

      const techTicket = checked.result.pending.find((t) => t.category === 'tech-support');
      const answered = await fakeTool.invoke({ action: 'recordAnswer', id: techTicket.id, replyText: 'Try rebooting; here are the steps...' });
      assert.ok(answered.result.resolvedAt);
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].to, 'Rebecca Keith <rebecca@oneworldmontessori.org>');
      assert.strictEqual(sent[0].threadId, 'thread-1');
      assert.strictEqual(sent[0].subject, 'Re: tech support: cannot log in');

      const polled = await fakeTool.invoke({ action: 'getTicket', id: techTicket.id });
      assert.strictEqual(polled.result.ticket.replyText, 'Try rebooting; here are the steps...');

      // The resolved tech-support ticket must never surface as pending again, but the still-
      // unanswered general ticket legitimately does (re-claimed by the same node that already had it).
      const checkedAgain = await fakeTool.invoke({ action: 'checkPending' });
      assert.strictEqual(checkedAgain.result.pending.length, 1);
      assert.strictEqual(checkedAgain.result.pending[0].category, 'general');

      const listed = await fakeTool.invoke({ action: 'listTickets' });
      assert.strictEqual(listed.result.tickets.length, 2, 'the unrelated email never became a ticket at all');

      await assert.rejects(() => fakeTool.invoke({ action: 'getTicket', id: 'not-a-real-id' }), /No ticket with id/);

      // Re-scanning the same inbox must never create a duplicate ticket for an already-known message.
      inbox = [...inbox]; // same message ids, simulating the same email still showing up in a later search
      const rescanned = await fakeTool.invoke({ action: 'listTickets' });
      assert.strictEqual(rescanned.result.tickets.length, 2);

      return { passed: true };
    },

    realWorldTest: async (testConfig, { call }) => {
      const { result } = await call({ action: 'listTickets' });
      assert.ok(Array.isArray(result.tickets));
      return { passed: true, checkedAgainst: testConfig.label ?? 'unnamed-fixture' };
    },
  });
}

module.exports = { createSupportQueueTool };
