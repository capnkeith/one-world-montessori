'use strict';

const assert = require('node:assert');
const { z } = require('zod');
const { Tool } = require('../core/Tool');

/**
 * A null/sample tool. Its only real job is to prove the pattern: it calls
 * doctor internally via ctx.call(), so its result's nested.versionLineage
 * shows the full name@version chain (echo@1.0.0 -> doctor@1.0.0) rather
 * than just the top-level call. Replace this with real Google Workspace
 * tools once those are scoped.
 */
function createEchoTool({ getDoctorTool }) {
  return new Tool({
    name: 'echo',
    version: '1.0.0',
    description: 'Sample tool: echoes input and calls doctor internally to demonstrate nested version lineage.',
    mcpInputSchema: { message: z.string().optional() },

    run: async (params, ctx) => {
      const doctorTool = getDoctorTool();
      const nested = await ctx.call(doctorTool, {});
      return {
        echoed: params?.message ?? null,
        nested,
      };
    },

    internalTest: async ({ call }) => {
      const { result, versionLineage } = await call({ message: 'hello' });
      assert.strictEqual(result.echoed, 'hello');
      assert.deepStrictEqual(versionLineage, [{ tool: 'echo', version: '1.0.0' }]);
      assert.deepStrictEqual(result.nested.versionLineage, [
        { tool: 'echo', version: '1.0.0' },
        { tool: 'doctor', version: '1.0.0' },
      ]);
      return { passed: true };
    },

    realWorldTest: async (testConfig, { call }) => {
      const message = testConfig.message ?? 'real-world-ping';
      const { result } = await call({ message });
      assert.strictEqual(result.echoed, message);
      return { passed: true };
    },
  });
}

module.exports = { createEchoTool };
