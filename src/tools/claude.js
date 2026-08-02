'use strict';

const assert = require('node:assert');
const { z } = require('zod');
const { Tool } = require('../core/Tool');

function defaultAnthropicClientFactory({ apiKey }) {
  const Anthropic = require('@anthropic-ai/sdk').default;
  return new Anthropic({ apiKey });
}

/**
 * Runs one question through the Claude API Tool Runner, giving Claude
 * access to browse_drive/search_drive/list_online_peers (thin proxies onto
 * the already-registered drive/channel tools via ctx.call). Claude is
 * required to finish by calling respond_with_files or respond_with_text —
 * this makes the files-vs-text decision an explicit tool call instead of
 * something the caller has to guess from free-text output.
 */
async function runClaudeQuery({ client, query, driveTool, channelTool, ctx }) {
  const { betaZodTool } = require('@anthropic-ai/sdk/helpers/beta/zod');

  let finalAnswer = null;

  const browseDrive = betaZodTool({
    name: 'browse_drive',
    description: "List files/folders in a Google Drive folder. Omit folderId to browse the user's Drive root.",
    inputSchema: z.object({ folderId: z.string().optional() }),
    run: async ({ folderId }) => {
      const { result } = await ctx.call(driveTool, { action: 'browse', folderId });
      return JSON.stringify(result);
    },
  });

  const searchDrive = betaZodTool({
    name: 'search_drive',
    description: 'Search the Google Drive account by file/folder name.',
    inputSchema: z.object({ query: z.string() }),
    run: async ({ query: driveQuery }) => {
      const { result } = await ctx.call(driveTool, { action: 'search', query: driveQuery });
      return JSON.stringify(result);
    },
  });

  const listOnlinePeers = betaZodTool({
    name: 'list_online_peers',
    description: 'List other OWM instances currently online.',
    inputSchema: z.object({}),
    run: async () => {
      const { result } = await ctx.call(channelTool, { action: 'list' });
      return JSON.stringify(result);
    },
  });

  const respondWithFiles = betaZodTool({
    name: 'respond_with_files',
    description:
      'Deliver your final answer when it is best shown as a list of files/folders (drawn from browse_drive/search_drive results). Call this exactly once, as your last action.',
    inputSchema: z.object({
      summary: z.string().describe('One-sentence summary of what these files are'),
      files: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          isFolder: z.boolean(),
          mimeType: z.string().optional(),
          webViewLink: z.string().optional(),
        })
      ),
    }),
    run: async (input) => {
      finalAnswer = { type: 'files', summary: input.summary, files: input.files };
      return 'Delivered to user.';
    },
  });

  const respondWithText = betaZodTool({
    name: 'respond_with_text',
    description:
      'Deliver your final answer as plain text — for anything that is not a file/folder listing (explanations, status, who is online, etc). Call this exactly once, as your last action.',
    inputSchema: z.object({ text: z.string() }),
    run: async (input) => {
      finalAnswer = { type: 'text', text: input.text };
      return 'Delivered to user.';
    },
  });

  const runner = client.beta.messages.toolRunner({
    model: 'claude-opus-5',
    max_tokens: 4096,
    system:
      'You help a user browse their Google Drive and see who else is online in this app. ' +
      'Use browse_drive, search_drive, and list_online_peers as needed to answer. ' +
      'When you have your final answer, you MUST call exactly one of respond_with_files ' +
      '(when the answer is a file/folder listing) or respond_with_text (for anything else) ' +
      '— never answer in plain assistant text.',
    tools: [browseDrive, searchDrive, listOnlinePeers, respondWithFiles, respondWithText],
    messages: [{ role: 'user', content: query }],
  });
  await runner;

  return finalAnswer ?? { type: 'text', text: '(Claude did not produce an answer)' };
}

/**
 * Resolves a free-text reply to an automated task email (e.g. a reply to
 * send-monthly-invoice-email) into a structured decision, forced through
 * one tool call the same way runClaudeQuery forces respond_with_files/
 * respond_with_text — this is what makes "type whatever you want in the
 * reply" (Seth's design for the dispute-resolution loop) actually
 * produce something the scheduler's recordFeedback can store.
 *
 * DLP guardrail (Seth, explicit): this function deliberately takes no
 * driveTool at all — Claude resolving an email reply can adjust a job's
 * own params (recipient/cc/subject/body/line items, via update_job_params)
 * or escalate to Seth by email (escalate_to_seth, subject+body text only,
 * no attachment capability), but must never be able to browse/search Drive
 * and pull something new into the picture. If a future change ever wants
 * to give this path Drive access for some other reason, that access must
 * not be combined with mail-sending tools in the same tool-runner scope.
 */
async function runInterpretReply({ client, replyText, context, schedulerTool, mailTool, ctx }) {
  const { betaZodTool } = require('@anthropic-ai/sdk/helpers/beta/zod');

  let resolution = null;
  const tools = [];

  // Real autonomy, not just a classification label: if the reply points
  // out something fixable (wrong recipient, wrong amount, wrong content),
  // Claude corrects the job itself instead of just flagging it for a human.
  if (schedulerTool && context?.jobId) {
    tools.push(
      betaZodTool({
        name: 'update_job_params',
        description:
          "Correct this job's stored params based on what the reply said — e.g. fix a wrong recipient email, wrong amount, wrong content. Only include the fields that need to change; everything else is left as-is.",
        inputSchema: z.object({
          paramChanges: z.record(z.any()).describe('Only the job.params fields that need to change, e.g. {"to": "correct@email.com"}'),
        }),
        run: async ({ paramChanges }) => {
          // Flat { action, id, params }, matching the real scheduler tool's
          // updateJob contract exactly (src/tools/scheduler.js) — it never
          // reads a `type` or `attachments` field even if one were sent, so
          // this can only ever adjust the job's own params (recipient, cc,
          // subject, body, line items, ...), never redirect what it attaches
          // or turn it into a different kind of job.
          await ctx.call(schedulerTool, {
            action: 'updateJob',
            id: context.jobId,
            params: { ...(context.jobParams ?? {}), ...paramChanges },
          });
          return 'Job params updated.';
        },
      })
    );
  }

  // The escape hatch for anything that isn't a confident, unambiguous fix —
  // real human judgment beats a guess that could send something else wrong.
  if (mailTool) {
    tools.push(
      betaZodTool({
        name: 'escalate_to_seth',
        description:
          'Email Seth directly when you cannot confidently resolve this reply yourself — anything ambiguous, a real dispute, or a question needing human judgment.',
        // subject/body text only, deliberately no attachments field — this
        // is the DLP guardrail: Claude's escalation path can never attach
        // anything to an outbound email, full stop.
        inputSchema: z.object({ subject: z.string(), body: z.string() }),
        run: async ({ subject, body }) => {
          await ctx.call(mailTool, { action: 'send', to: 'seth@oneworldmontessori.org', subject, text: body });
          return 'Escalated to Seth.';
        },
      })
    );
  }

  const recordResolution = betaZodTool({
    name: 'record_resolution',
    description:
      'Record your final resolution of this reply. Call exactly once, as your last action, after taking whatever update_job_params/escalate_to_seth actions were actually needed (if any).',
    inputSchema: z.object({
      outcome: z.enum(['approved', 'updated', 'escalated', 'unclear']),
      note: z.string().describe('Brief explanation of your reasoning, referencing what the reply actually said'),
    }),
    run: async (input) => {
      resolution = input;
      return 'Recorded.';
    },
  });
  tools.push(recordResolution);

  const runner = client.beta.messages.toolRunner({
    model: 'claude-opus-5',
    max_tokens: 1024,
    system:
      'You are resolving a reply to an automated task email on behalf of One World Montessori. ' +
      "You'll be given context about what was originally sent (including the job's current params) and the text of a reply that came back. " +
      'If the reply confirms everything is correct, just record that as "approved". If the reply points out a ' +
      'specific, unambiguous correction you can make yourself, call update_job_params to fix it, then record ' +
      '"updated". If you cannot confidently resolve this on your own — anything ambiguous, a real dispute, or ' +
      'a question needing human judgment — call escalate_to_seth instead of guessing, then record "escalated". ' +
      'You MUST call record_resolution exactly once, as your last action.',
    tools,
    messages: [
      {
        role: 'user',
        content: `Context about the original task:\n${JSON.stringify(context ?? {})}\n\nReply received:\n${replyText}`,
      },
    ],
  });
  await runner;

  return resolution ?? { outcome: 'unclear', note: 'Claude did not produce a resolution.' };
}

// Minimal fakes for the internal test — never a real Tool instance, never a
// real Anthropic client. A driveTool/channelTool stand-in only needs an
// invoke() matching the { result, versionLineage } envelope Tool.invoke()
// returns, since ctx.call() just calls .invoke() on whatever's handed to it.
function fakeSecretStore() {
  const store = {};
  return {
    get: (k) => store[k] ?? null,
    set: (k, v) => {
      store[k] = v;
    },
    has: (k) => store[k] != null,
  };
}

function fakeDriveToolStub() {
  return {
    invoke: async () => ({
      result: { entries: [{ id: 'fake-file-1', name: 'Fake.txt', isFolder: false }] },
      versionLineage: [],
    }),
  };
}

function fakeChannelToolStub() {
  return {
    invoke: async () => ({ result: { peers: [] }, versionLineage: [] }),
  };
}

// Simulates "Claude decided to call these tools" without any real API call:
// branches on the query text so the internal test can exercise both the
// files-answer and text-answer paths through the same fake.
function fakeToolRunner(opts) {
  return (async () => {
    const query = opts.messages?.[0]?.content ?? '';
    const findTool = (name) => opts.tools.find((t) => t.name === name);
    const recordResolution = findTool('record_resolution');
    if (recordResolution) {
      if (/approve|looks correct|thank you/i.test(query)) {
        await recordResolution.run({ outcome: 'approved', note: 'Fake resolution based on reply text.' });
      } else if (/wrong email|wrong address/i.test(query)) {
        await findTool('update_job_params').run({ paramChanges: { to: 'corrected@example.com' } });
        await recordResolution.run({ outcome: 'updated', note: 'Fixed the recipient per the reply.' });
      } else {
        await findTool('escalate_to_seth').run({ subject: 'Needs your attention', body: 'Fake escalation body.' });
        await recordResolution.run({ outcome: 'escalated', note: 'Could not confidently resolve this myself.' });
      }
      return;
    }
    if (/folder|drive|file/i.test(query)) {
      await findTool('browse_drive').run({});
      await findTool('respond_with_files').run({
        summary: 'Fake summary',
        files: [{ id: 'fake-file-1', name: 'Fake.txt', isFolder: false }],
      });
    } else {
      await findTool('list_online_peers').run({});
      await findTool('respond_with_text').run({ text: 'Fake text answer' });
    }
  })();
}

// Never touches the real Anthropic API or a real driveTool/channelTool —
// builds its own fully-fake claude tool instance regardless of how the
// "outer" tool under test was actually constructed (same doctrine as
// driveInternalTest in drive.js).
async function claudeInternalTest() {
  const secretStore = fakeSecretStore();
  const driveTool = fakeDriveToolStub();
  const channelTool = fakeChannelToolStub();
  const updateJobCalls = [];
  const mailSendCalls = [];
  const schedulerTool = {
    invoke: async (params) => {
      updateJobCalls.push(params);
      return { result: { ...params }, versionLineage: [] };
    },
  };
  const mailTool = {
    invoke: async (params) => {
      mailSendCalls.push(params);
      return { result: { sent: true }, versionLineage: [] };
    },
  };

  const tool = createClaudeTool({
    secretStore,
    getDriveTool: () => driveTool,
    getChannelTool: () => channelTool,
    getSchedulerTool: () => schedulerTool,
    getMailTool: () => mailTool,
    anthropicClientFactory: () => ({ beta: { messages: { toolRunner: fakeToolRunner } } }),
  });

  const configured = await tool.invoke({ action: 'setup', apiKey: 'sk-ant-fake-test-key' });
  assert.strictEqual(configured.result.configured, true);
  assert.ok(secretStore.has('anthropic_api_key'));

  const filesAnswer = await tool.invoke({ action: 'query', query: 'what is in my drive folder?' });
  assert.strictEqual(filesAnswer.result.type, 'files');
  assert.ok(Array.isArray(filesAnswer.result.files));

  const textAnswer = await tool.invoke({ action: 'query', query: 'who is online?' });
  assert.strictEqual(textAnswer.result.type, 'text');
  assert.strictEqual(typeof textAnswer.result.text, 'string');

  const resolution = await tool.invoke({
    action: 'interpretReply',
    replyText: 'Looks correct, approved.',
    context: { jobLabel: 'Monthly invoice' },
  });
  assert.strictEqual(resolution.result.outcome, 'approved');
  assert.strictEqual(typeof resolution.result.note, 'string');
  assert.strictEqual(updateJobCalls.length, 0, 'approved should never touch the job');
  assert.strictEqual(mailSendCalls.length, 0, 'approved should never email Seth');

  const fixed = await tool.invoke({
    action: 'interpretReply',
    replyText: 'This has the wrong email, it should go to someone else.',
    context: { jobId: 'job-42', jobLabel: 'Monthly invoice', jobParams: { to: 'wrong@example.com', amount: 16 } },
  });
  assert.strictEqual(fixed.result.outcome, 'updated');
  assert.strictEqual(updateJobCalls.length, 1);
  assert.strictEqual(updateJobCalls[0].action, 'updateJob');
  assert.strictEqual(updateJobCalls[0].id, 'job-42');
  // Flat { action, id, params } — matches the real scheduler tool's
  // updateJob contract; a wrapping { patch: {...} } would silently no-op
  // against the real tool, which only reads params.params directly.
  assert.deepStrictEqual(updateJobCalls[0].params, { to: 'corrected@example.com', amount: 16 });
  assert.strictEqual(updateJobCalls[0].patch, undefined);
  assert.strictEqual(updateJobCalls[0].attachments, undefined, 'update_job_params must never be able to set attachments');
  assert.strictEqual(updateJobCalls[0].type, undefined, 'update_job_params must never be able to change the job type');

  const escalated = await tool.invoke({
    action: 'interpretReply',
    replyText: 'Why am I getting this? This makes no sense.',
    context: { jobId: 'job-42', jobLabel: 'Monthly invoice', jobParams: {} },
  });
  assert.strictEqual(escalated.result.outcome, 'escalated');
  assert.strictEqual(mailSendCalls.length, 1);
  assert.strictEqual(mailSendCalls[0].to, 'seth@oneworldmontessori.org');
  assert.ok(mailSendCalls[0].subject);

  const unconfigured = createClaudeTool({
    secretStore: fakeSecretStore(),
    getDriveTool: () => driveTool,
    getChannelTool: () => channelTool,
    anthropicClientFactory: () => ({ beta: { messages: { toolRunner: fakeToolRunner } } }),
  });
  await assert.rejects(
    () => unconfigured.invoke({ action: 'query', query: 'anything' }),
    /Anthropic API key not configured/
  );

  return { passed: true };
}

function createClaudeTool({
  secretStore,
  getDriveTool,
  getChannelTool,
  getSchedulerTool,
  getMailTool,
  anthropicClientFactory = defaultAnthropicClientFactory,
}) {
  return new Tool({
    name: 'claude',
    version: '1.2.0',
    description:
      "Ask Claude a question; Claude can browse/search this account's Drive, list online peers, and (via interpretReply) act on email replies to scheduled jobs.",
    mcpInputSchema: {
      action: z.enum(['setup', 'query', 'interpretReply']).optional(),
      apiKey: z.string().optional(),
      query: z.string().optional(),
      replyText: z.string().optional(),
      context: z.any().optional(),
    },

    run: async (params, ctx) => {
      const action = params?.action ?? 'query';

      if (action === 'setup') {
        if (!params.apiKey) throw new Error('setup requires apiKey');
        secretStore.set('anthropic_api_key', params.apiKey);
        return { configured: true };
      }

      if (action === 'query') {
        if (!params.query) throw new Error('query requires a query string');
        if (!secretStore.has('anthropic_api_key')) {
          throw new Error('Anthropic API key not configured — run `claude setup` first');
        }
        const client = anthropicClientFactory({ apiKey: secretStore.get('anthropic_api_key') });
        return runClaudeQuery({
          client,
          query: params.query,
          driveTool: getDriveTool(),
          channelTool: getChannelTool(),
          ctx,
        });
      }

      if (action === 'interpretReply') {
        if (!params.replyText) throw new Error('interpretReply requires replyText');
        if (!secretStore.has('anthropic_api_key')) {
          throw new Error('Anthropic API key not configured — run `claude setup` first');
        }
        const client = anthropicClientFactory({ apiKey: secretStore.get('anthropic_api_key') });
        return runInterpretReply({
          client,
          replyText: params.replyText,
          context: params.context,
          schedulerTool: getSchedulerTool ? getSchedulerTool() : null,
          mailTool: getMailTool ? getMailTool() : null,
          ctx,
        });
      }

      throw new Error(`Unknown claude action: ${action}`);
    },

    internalTest: claudeInternalTest,

    realWorldTest: async (testConfig, { call }) => {
      if (!testConfig.query) {
        return { passed: true, skipped: true, reason: 'testConfig.query not provided — skipping real Claude API call' };
      }
      const { result } = await call({ action: 'query', query: testConfig.query });
      assert.ok(result.type === 'files' || result.type === 'text');
      return { passed: true, checkedAgainst: testConfig.label ?? 'unnamed-fixture' };
    },
  });
}

module.exports = { createClaudeTool, runClaudeQuery, runInterpretReply };
