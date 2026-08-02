#!/usr/bin/env node
'use strict';

const { createContext } = require('./context');
const { SERVER_VERSION } = require('./version');

// The CLI is only ever run directly by a human (never by the automated
// boot/supervisor/install pipeline) - see src/core/interactiveConsent.js
// for why this can't just be process.stdout.isTTY.
process.env.OWM_ALLOW_INTERACTIVE_CONSENT = '1';

function printUsage() {
  console.log(`owm-cli ${SERVER_VERSION}

Usage:
  owm-cli list                         List registered tools and their versions
  owm-cli call <tool> [json-params]    Invoke a tool directly
  owm-cli test [--real-world] [config] Run internal (and optionally real-world) tests
  owm-cli doctor                       Shorthand for: call doctor {}
`);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { toolSet } = createContext();

  if (!command || command === 'help' || command === '--help') {
    printUsage();
    return 0;
  }

  if (command === 'list') {
    console.log(JSON.stringify(toolSet.list(), null, 2));
    return 0;
  }

  if (command === 'doctor') {
    const { result } = await toolSet.invoke('doctor', {});
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === 'call') {
    const [toolName, paramsJson] = rest;
    if (!toolName) {
      console.error('Usage: owm-cli call <tool> [json-params]');
      return 1;
    }
    const params = paramsJson ? JSON.parse(paramsJson) : {};
    const { result, versionLineage } = await toolSet.invoke(toolName, params);
    console.log(JSON.stringify({ result, versionLineage }, null, 2));
    return 0;
  }

  if (command === 'test') {
    const realWorld = rest.includes('--real-world');
    const configArg = rest.find((a) => !a.startsWith('--'));
    const testConfig = configArg ? JSON.parse(configArg) : null;
    const results = await toolSet.runAllTests({ realWorld, testConfig });
    console.log(JSON.stringify(results, null, 2));
    const anyFailed = Object.values(results).some(
      (r) => r.internal.passed === false || r.real.passed === false
    );
    return anyFailed ? 1 : 0;
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  return 1;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
