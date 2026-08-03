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
const { createSchedulerTool } = require('./scheduler');
const { buildJobHandlers } = require('./jobHandlers');
const { createMailTool } = require('./mail');
const { createDisputeResolverTool } = require('./disputeResolver');
const { createPdfTool } = require('./pdf');
const { createInvoiceTool } = require('./invoice');
const { createWorkerTool } = require('./worker');
const { createPromptQueueTool } = require('./promptQueue');
const { createChatTool } = require('./chat');

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
  jobStore,
  promptStore,
  workerHeartbeat,
  invoiceCounter,
  invoiceLogoBuffer,
}) {
  const toolSet = new ToolSet({ name: 'owm-tools', version: TOOLSET_VERSION, instanceId, displayName, secretStore });

  // Assigned after creation below; doctor/claude only read these at
  // invoke-time (via the closure), by which point buildToolSet has finished.
  let channelTool;
  let schedulerTool;
  let mailTool;

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

  channelTool = createChannelTool({ channel, instanceId, displayName, secretStore, toolSetRef: () => toolSet });
  toolSet.register(channelTool);

  const chatTool = createChatTool({ getChannelTool: () => channelTool, instanceId });
  toolSet.register(chatTool);

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
    getSchedulerTool: () => schedulerTool,
    getMailTool: () => mailTool,
  });
  toolSet.register(claudeTool);

  mailTool = createMailTool({ secretStore });
  toolSet.register(mailTool);

  const pdfTool = createPdfTool();
  toolSet.register(pdfTool);

  const invoiceTool = createInvoiceTool({
    invoiceCounter,
    logoBuffer: invoiceLogoBuffer,
    getPdfTool: () => pdfTool,
  });
  toolSet.register(invoiceTool);

  schedulerTool = createSchedulerTool({
    jobStore,
    handlers: buildJobHandlers({ getMailTool: () => mailTool, getSchedulerTool: () => schedulerTool }),
    nodeId: instanceId,
  });
  toolSet.register(schedulerTool);

  const disputeResolverTool = createDisputeResolverTool({
    getSchedulerTool: () => schedulerTool,
    getMailTool: () => mailTool,
  });
  toolSet.register(disputeResolverTool);

  const workerTool = createWorkerTool();
  toolSet.register(workerTool);

  const promptQueueTool = createPromptQueueTool({ promptStore, heartbeat: workerHeartbeat, nodeId: instanceId });
  toolSet.register(promptQueueTool);

  return toolSet;
}

module.exports = { buildToolSet };
