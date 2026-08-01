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

test('ToolSet.invoke attaches ctx.user to every call, resolved once and cached', async () => {
  let whoamiCalls = 0;
  const secretStore = { has: (key) => key === 'google_oauth_refresh_token' };
  const toolSet = new ToolSet({ name: 'ts', version: '1.0.0', instanceId: 'inst-1', displayName: 'Local Name', secretStore });

  toolSet.register(
    new Tool({
      name: 'drive',
      version: '1.0.0',
      run: async (params) => {
        if (params.action === 'whoami') {
          whoamiCalls += 1;
          return { displayName: 'Real Google Name', photoLink: 'https://example.com/p.jpg', emailAddress: 'real@example.com' };
        }
        throw new Error('unexpected action');
      },
    })
  );
  toolSet.register(
    new Tool({
      name: 'echoUser',
      version: '1.0.0',
      run: async (_params, ctx) => ctx.user,
    })
  );

  const first = await toolSet.invoke('echoUser', {});
  assert.deepStrictEqual(first.result, {
    instanceId: 'inst-1',
    displayName: 'Real Google Name',
    photoLink: 'https://example.com/p.jpg',
    emailAddress: 'real@example.com',
  });

  await toolSet.invoke('echoUser', {});
  assert.strictEqual(whoamiCalls, 1, 'identity should be resolved once and cached, not re-fetched on every invoke');
});

test('ToolSet.invoke never calls the drive tool for identity when no refresh token exists (regression: this used to hang launching a real OAuth flow)', async () => {
  let driveCalled = false;
  const secretStore = { has: () => false };
  const toolSet = new ToolSet({ name: 'ts', version: '1.0.0', instanceId: 'inst-2', displayName: 'Fallback Name', secretStore });

  toolSet.register(
    new Tool({
      name: 'drive',
      version: '1.0.0',
      run: async () => {
        driveCalled = true;
        throw new Error('drive should never be called here');
      },
    })
  );
  toolSet.register(
    new Tool({
      name: 'echoUser',
      version: '1.0.0',
      run: async (_params, ctx) => ctx.user,
    })
  );

  const { result } = await toolSet.invoke('echoUser', {});
  assert.strictEqual(driveCalled, false);
  assert.deepStrictEqual(result, { instanceId: 'inst-2', displayName: 'Fallback Name', photoLink: undefined, emailAddress: undefined });
});

test('ToolSet.invoke respects an explicitly-passed ctx.user without resolving identity at all', async () => {
  let driveCalled = false;
  const secretStore = { has: () => true };
  const toolSet = new ToolSet({ name: 'ts', version: '1.0.0', instanceId: 'inst-3', displayName: 'X', secretStore });

  toolSet.register(
    new Tool({
      name: 'drive',
      version: '1.0.0',
      run: async () => {
        driveCalled = true;
        return { displayName: 'Should Not Be Used' };
      },
    })
  );
  toolSet.register(
    new Tool({
      name: 'echoUser',
      version: '1.0.0',
      run: async (_params, ctx) => ctx.user,
    })
  );

  const explicitUser = { instanceId: 'someone-else', displayName: 'Explicit User' };
  const { result } = await toolSet.invoke('echoUser', {}, { user: explicitUser });
  assert.deepStrictEqual(result, explicitUser);
  assert.strictEqual(driveCalled, false);
});
