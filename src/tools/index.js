'use strict';

const { ToolSet } = require('../core/ToolSet');
const { TOOLSET_VERSION } = require('../version');
const { createDoctorTool } = require('./doctor');
const { createEchoTool } = require('./echo');
const { createChannelTool } = require('./channel');
const { createDriveTool } = require('./drive');
const { createDropboxTool } = require('./dropbox');
const { createCatalogTool } = require('./catalog');
const { createClaudeTool } = require('./claude');

/**
 * Builds the one shared ToolSet instance that every front end (CLI, MCP
 * stdio server, local HTTP server) mounts. Adding a new tool means
 * writing it once here — it shows up in all three interfaces for free.
 */
function buildToolSet({
  secretStore,
  sharedSecretStore,
  profile,
  channel,
  instanceId,
  displayName,
  catalog,
  catalogEventLog,
  persistCatalogSnapshot,
}) {
  const toolSet = new ToolSet({ name: 'owm-tools', version: TOOLSET_VERSION, instanceId, displayName, secretStore });

  // Assigned after creation below; doctor only reads it at invoke-time
  // (via the closure), by which point buildToolSet has finished.
  let channelTool;

  const doctorTool = createDoctorTool({
    toolSetRef: () => toolSet,
    secretStore,
    profile,
    getChannelTool: () => channelTool,
  });
  toolSet.register(doctorTool);

  const echoTool = createEchoTool({
    getDoctorTool: () => doctorTool,
  });
  toolSet.register(echoTool);

  channelTool = createChannelTool({ channel, instanceId, displayName, toolSetRef: () => toolSet });
  toolSet.register(channelTool);

  const driveTool = createDriveTool({ secretStore, profile });
  toolSet.register(driveTool);

  const dropboxTool = createDropboxTool({ secretStore, sharedSecretStore });
  toolSet.register(dropboxTool);

  const catalogTool = createCatalogTool({
    eventLog: catalogEventLog,
    catalogRef: () => catalog,
    persistSnapshot: persistCatalogSnapshot,
  });
  toolSet.register(catalogTool);

  const claudeTool = createClaudeTool({
    secretStore,
    getDriveTool: () => driveTool,
    getChannelTool: () => channelTool,
  });
  toolSet.register(claudeTool);

  return toolSet;
}

module.exports = { buildToolSet };
