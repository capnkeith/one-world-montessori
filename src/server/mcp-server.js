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
async function main() {
  const { toolSet } = createContext();

  const server = new McpServer({ name: 'owm-mcp', version: SERVER_VERSION });

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
