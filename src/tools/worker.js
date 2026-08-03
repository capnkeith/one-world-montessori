'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert');
const { z } = require('zod');
const { Tool } = require('../core/Tool');

const WORKER_MD_PATH = path.join(__dirname, '..', '..', 'WORKER.md');

/**
 * The join point for a new Claude compute node: `register` returns
 * WORKER.md's content over MCP, so a node never needs this git repo
 * checked out locally to learn how to participate in job processing —
 * only an MCP connection to a running OWM Drive install (`claude mcp add
 * owm-drive -- node "<install>\src\server\mcp-server.js"`). Kept as its
 * own tiny tool rather than folded into doctor/disputeResolver: "how do I
 * join the compute pool" is a different concern from "is this install
 * healthy" or "what replies need resolving", and neither of those should
 * need to know this exists.
 */
function createWorkerTool({ readInstructions = () => fs.readFileSync(WORKER_MD_PATH, 'utf8') } = {}) {
  return new Tool({
    name: 'worker',
    version: '1.0.0',
    description: "Registration point for a Claude compute node joining the job-processing pool — call `register` first to learn how to participate.",
    mcpInputSchema: {
      action: z.enum(['register']).optional(),
    },

    run: async (params) => {
      const action = params?.action ?? 'register';
      if (action === 'register') {
        return { instructions: readInstructions() };
      }
      throw new Error(`Unknown worker action: ${action}`);
    },

    // Injects a fake instructions string rather than reading the real
    // WORKER.md — proves the plumbing without the test being brittle
    // against that file's actual prose changing.
    internalTest: async ({ call }) => {
      const fakeTool = createWorkerTool({ readInstructions: () => '# fake instructions\n\nhello.' });
      const { result } = await fakeTool.invoke({ action: 'register' });
      assert.strictEqual(result.instructions, '# fake instructions\n\nhello.');
      return { passed: true };
    },

    // The real-world check: WORKER.md must actually exist and be
    // non-empty in a real install, not just in the fake-injected test above.
    realWorldTest: async (testConfig, { call }) => {
      const { result } = await call({ action: 'register' });
      assert.ok(typeof result.instructions === 'string' && result.instructions.length > 0);
      return { passed: true, checkedAgainst: testConfig.label ?? 'unnamed-fixture' };
    },
  });
}

module.exports = { createWorkerTool };
