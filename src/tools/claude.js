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
 */
async function runInterpretReply({ client, replyText, context }) {
  const { betaZodTool } = require('@anthropic-ai/sdk/helpers/beta/zod');

  let resolution = null;

  const recordResolution = betaZodTool({
    name: 'record_resolution',
    description: 'Record your resolution of this reply. Call exactly once, as your last action.',
    inputSchema: z.object({
      outcome: z.enum(['approved', 'disputed', 'unclear']),
      note: z.string().describe('Brief explanation of your reasoning, referencing what the reply actually said'),
    }),
    run: async (input) => {
      resolution = input;
      return 'Recorded.';
    },
  });

  const runner = client.beta.messages.toolRunner({
    model: 'claude-opus-5',
    max_tokens: 1024,
    system:
      'You are resolving a reply to an automated task email on behalf of One World Montessori. ' +
      "You'll be given context about what was originally sent and the text of a reply that came back. " +
      'Decide whether the reply approves the task, disputes/objects to it, or is unclear, and briefly ' +
      'explain why using what the reply actually said. You MUST call record_resolution exactly once.',
    tools: [recordResolution],
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
      const outcome = /approve|looks correct|thank you/i.test(query) ? 'approved' : 'disputed';
      await recordResolution.run({ outcome, note: 'Fake resolution based on reply text.' });
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

  const tool = createClaudeTool({
    secretStore,
    getDriveTool: () => driveTool,
    getChannelTool: () => channelTool,
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

function createClaudeTool({ secretStore, getDriveTool, getChannelTool, anthropicClientFactory = defaultAnthropicClientFactory }) {
  return new Tool({
    name: 'claude',
    version: '1.1.0',
    description: "Ask Claude a question; Claude can browse/search this account's Drive and list online peers to answer.",
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
        return runInterpretReply({ client, replyText: params.replyText, context: params.context });
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
