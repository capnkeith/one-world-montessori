'use strict';

/**
 * A single versioned unit of capability.
 *
 * Every Tool carries its own semver `version` independent of the server and
 * ToolSet versions around it. When a tool's `run` calls another tool via
 * `ctx.call(...)`, the callee's invoke() appends {name, version} to the
 * ambient trace it was handed, so the deepest call in a chain reports the
 * full name@version lineage of everything that ran to produce it.
 */
class Tool {
  constructor({
    name,
    version,
    description = '',
    run,
    internalTest = null,
    realWorldTest = null,
    mcpInputSchema = {},
  }) {
    if (!name) throw new Error('Tool requires a name');
    if (!version) throw new Error(`Tool "${name}" requires a version`);
    if (typeof run !== 'function') throw new Error(`Tool "${name}" requires a run function`);

    this.name = name;
    this.version = version;
    this.description = description;
    this._run = run;
    this._internalTest = internalTest;
    this._realWorldTest = realWorldTest;
    // ZodRawShapeCompat consumed only by the MCP front end (src/server/mcp-server.js).
    // Kept on the tool itself so registering a new tool with MCP needs no
    // change to the server — {} means "no arguments".
    this.mcpInputSchema = mcpInputSchema;
  }

  /**
   * Invoke this tool. `ctx.trace` is the ordered list of {name, version}
   * calls that led here; this call appends itself before running, and
   * hands the extended trace to any nested calls made via ctx.call().
   * `ctx.user` (normally set once by ToolSet.invoke, see ToolSet.js) is
   * echoed back on every response — every call happens "in the context
   * of" whichever real account is behind it, not just whichever process
   * happens to be running, so a future multi-user server needs no change
   * here, only a different way of populating ctx.user per request.
   */
  async invoke(params, ctx = {}) {
    const parentTrace = ctx.trace ?? [];
    const ownRecord = { tool: this.name, version: this.version };
    const trace = [...parentTrace, ownRecord];

    const childCtx = {
      ...ctx,
      trace,
      call: (tool, childParams) => tool.invoke(childParams, childCtx),
    };

    const result = await this._run(params, childCtx);
    return { result, versionLineage: trace, user: ctx.user ?? null };
  }

  hasInternalTest() {
    return typeof this._internalTest === 'function';
  }

  hasRealWorldTest() {
    return typeof this._realWorldTest === 'function';
  }

  async runInternalTest() {
    if (!this.hasInternalTest()) return { skipped: true, reason: 'no internal test defined' };
    try {
      const outcome = await this._internalTest({
        call: (params, ctx) => this.invoke(params, ctx),
      });
      return { skipped: false, passed: true, ...outcome };
    } catch (err) {
      return { skipped: false, passed: false, error: err.message };
    }
  }

  /**
   * Real-world tests perform actual actions against fixtures named in
   * testConfig (e.g. a test Google Workspace user/domain) rather than
   * mocks. testConfig is required — there is no sane default target for
   * "do this for real".
   */
  async runRealWorldTest(testConfig) {
    if (!this.hasRealWorldTest()) return { skipped: true, reason: 'no real-world test defined' };
    if (!testConfig) {
      return { skipped: true, reason: 'no testConfig supplied (needs test server/test user)' };
    }
    try {
      const outcome = await this._realWorldTest(testConfig, {
        call: (params, ctx) => this.invoke(params, ctx),
      });
      return { skipped: false, passed: true, ...outcome };
    } catch (err) {
      return { skipped: false, passed: false, error: err.message };
    }
  }
}

module.exports = { Tool };
