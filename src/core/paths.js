'use strict';

const os = require('os');
const path = require('path');

/**
 * Central home for where OWM keeps local state. Kept in one place so the
 * installer, CLI, servers, and doctor tool all agree on the same paths.
 */
const STATE_ROOT = path.join(os.homedir(), '.owm-mcp');

module.exports = {
  STATE_ROOT,
  PROFILE_PATH: path.join(STATE_ROOT, 'profile.json'),
  SECRETS_DIR: path.join(STATE_ROOT, 'secrets'),
  VERSIONS_DIR: path.join(STATE_ROOT, 'versions'),
  CURRENT_LINK: path.join(STATE_ROOT, 'current'),
  HTTP_DEFAULT_PORT: 39390,
};
