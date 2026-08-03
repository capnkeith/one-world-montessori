#!/usr/bin/env node
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createContext } = require('../context');
const { SERVER_VERSION } = require('../version');

/**
 * This is the MCP front end used directly by technical staff through a
 * real MCP host (Claude Desktop/Code) — the tools it exposes are exactly
 * the same versioned ToolSet the CLI and local HTTP server use.
 */
// Regression (2026-08-03): the `worker` tool's `register` action was the
// only join point for a new Claude compute node (see WORKER.md), but
// nothing ever told a freshly-connected session to actually call it —
// it was just one more tool description among many, easy to never
// notice. MCP's own protocol has a real mechanism for this: the
// `instructions` field returned in the initialize handshake, which a
// compliant client surfaces to the model directly. Setting it here is
// what actually wires a new session (Johanna's, or anyone else's, with
// no repo checked out) into calling `worker.register` on its own,
// instead of relying on a human to say so or on CLAUDE.md happening to
// be present in a local checkout.
const MCP_INSTRUCTIONS =
  'Before doing anything else: call the `worker` tool with {"action":"register"} once. ' +
  'It returns the current, versioned recipe (WORKER.md) for participating in this OWM install\'s ' +
  'background job processing (email-reply resolution, the Ask-Claude prompt queue, and any future ' +
  "queues), plus which real users are expected to participate and how. Follow it.";

async function main() {
  const { toolSet } = createContext();

  const server = new McpServer({ name: 'owm-mcp', version: SERVER_VERSION }, { instructions: MCP_INSTRUCTIONS });

  for (const { name, description } of toolSet.list()) {
    const tool = toolSet.get(name);
    server.registerTool(
      name,
      {
        description: `[v${tool.version}] ${description}`,
        inputSchema: tool.mcpInputSchema,
      },
      async (params) => {
        const { result, versionLineage } = await toolSet.invoke(name, params ?? {});
        return {
          content: [{ type: 'text', text: JSON.stringify({ result, versionLineage }, null, 2) }],
          structuredContent: { result, versionLineage },
        };
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { MCP_INSTRUCTIONS };
