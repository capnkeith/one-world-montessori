'use strict';

/**
 * A versioned registry of Tools. The ToolSet has its own version,
 * independent of both the server version and each individual tool's
 * version — bump it when the shape of the registry itself changes
 * (tools added/removed), not when a single tool's internals change.
 */
class ToolSet {
  constructor({ name, version }) {
    if (!name) throw new Error('ToolSet requires a name');
    if (!version) throw new Error('ToolSet requires a version');
    this.name = name;
    this.version = version;
    this._tools = new Map();
  }

  register(tool) {
    if (this._tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this._tools.set(tool.name, tool);
    return this;
  }

  get(name) {
    const tool = this._tools.get(name);
    if (!tool) throw new Error(`Unknown tool: "${name}"`);
    return tool;
  }

  has(name) {
    return this._tools.has(name);
  }

  list() {
    return [...this._tools.values()].map((t) => ({
      name: t.name,
      version: t.version,
      description: t.description,
    }));
  }

  async invoke(name, params, ctx = {}) {
    const tool = this.get(name);
    return tool.invoke(params, { ...ctx, toolSet: this });
  }

  /**
   * Runs internal (canned) tests for every tool, and real-world tests
   * when explicitly opted into with a testConfig. Never runs real-world
   * tests by accident — that would mean silently taking real actions.
   */
  async runAllTests({ realWorld = false, testConfig = null } = {}) {
    const results = {};
    for (const tool of this._tools.values()) {
      const internal = await tool.runInternalTest();
      const real = realWorld
        ? await tool.runRealWorldTest(testConfig)
        : { skipped: true, reason: 'real-world tests not requested' };
      results[tool.name] = { internal, real };
    }
    return results;
  }
}

module.exports = { ToolSet };
