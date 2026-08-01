'use strict';

const { resolveIdentity } = require('./identity');

/**
 * A versioned registry of Tools. The ToolSet has its own version,
 * independent of both the server version and each individual tool's
 * version — bump it when the shape of the registry itself changes
 * (tools added/removed), not when a single tool's internals change.
 */
class ToolSet {
  constructor({ name, version, instanceId, displayName, secretStore }) {
    if (!name) throw new Error('ToolSet requires a name');
    if (!version) throw new Error('ToolSet requires a version');
    this.name = name;
    this.version = version;
    this.instanceId = instanceId;
    this.displayName = displayName;
    this.secretStore = secretStore;
    this._tools = new Map();
    this._cachedUser = null;
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

  /**
   * Resolved once (real Google name/photo via the drive tool's whoami, see
   * src/core/identity.js) and cached for the life of this ToolSet — every
   * invoke() made through this entry point is attributed to the same
   * account, matching today's one-account-per-process reality. A future
   * per-session server would resolve/cache this per-session instead and
   * pass its own ctx.user in explicitly; nothing below this layer would
   * need to change.
   */
  async _resolveUser() {
    if (!this._cachedUser) {
      this._cachedUser = await resolveIdentity({ toolSet: this, instanceId: this.instanceId, displayName: this.displayName, secretStore: this.secretStore });
    }
    return this._cachedUser;
  }

  async invoke(name, params, ctx = {}) {
    const tool = this.get(name);
    const user = ctx.user ?? (await this._resolveUser());
    return tool.invoke(params, { ...ctx, toolSet: this, user });
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
