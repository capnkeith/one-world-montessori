'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Tool } = require('../src/core/Tool');
const { ToolSet } = require('../src/core/ToolSet');

test('Tool.invoke records its own name@version in versionLineage', async () => {
  const tool = new Tool({
    name: 'noop',
    version: '2.3.4',
    run: async (params) => ({ received: params }),
  });

  const { result, versionLineage } = await tool.invoke({ a: 1 });
  assert.deepStrictEqual(result, { received: { a: 1 } });
  assert.deepStrictEqual(versionLineage, [{ tool: 'noop', version: '2.3.4' }]);
});

test('nested ctx.call() accumulates full version lineage down the chain', async () => {
  const inner = new Tool({
    name: 'inner',
    version: '1.0.0',
    run: async () => ({ innerRan: true }),
  });
  const outer = new Tool({
    name: 'outer',
    version: '9.9.9',
    run: async (_params, ctx) => {
      const nested = await ctx.call(inner, {});
      return { nested };
    },
  });

  const { result } = await outer.invoke({});
  assert.deepStrictEqual(result.nested.versionLineage, [
    { tool: 'outer', version: '9.9.9' },
    { tool: 'inner', version: '1.0.0' },
  ]);
});

test('ToolSet rejects duplicate registration and unknown lookups', () => {
  const toolSet = new ToolSet({ name: 'ts', version: '1.0.0' });
  const tool = new Tool({ name: 'a', version: '1.0.0', run: async () => ({}) });
  toolSet.register(tool);
  assert.throws(() => toolSet.register(tool));
  assert.throws(() => toolSet.get('missing'));
  assert.strictEqual(toolSet.has('a'), true);
});

test('ToolSet.runAllTests skips real-world tests unless explicitly requested', async () => {
  const toolSet = new ToolSet({ name: 'ts', version: '1.0.0' });
  toolSet.register(
    new Tool({
      name: 'a',
      version: '1.0.0',
      run: async () => ({}),
      internalTest: async ({ call }) => {
        await call({});
        return { passed: true };
      },
      realWorldTest: async () => ({ passed: true }),
    })
  );

  const withoutRealWorld = await toolSet.runAllTests();
  assert.strictEqual(withoutRealWorld.a.internal.passed, true);
  assert.strictEqual(withoutRealWorld.a.real.skipped, true);

  const withRealWorld = await toolSet.runAllTests({ realWorld: true, testConfig: { label: 'fixture' } });
  assert.strictEqual(withRealWorld.a.real.passed, true);
});
