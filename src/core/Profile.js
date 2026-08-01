'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Non-secret per-user settings, stored separately from SecretStore.
 * Anything that would need to be "never revealed in the clear" belongs
 * in SecretStore instead — Profile is safe to print, log, or ship in a
 * bug report wholesale.
 */
class Profile {
  static defaults() {
    return {
      instanceId: null,
      displayName: null,
      googleAccount: null,
      testMode: false,
      preferences: {},
      driveHiddenFolderIds: [], // folders excluded from drive.browse/search results (e.g. a personal folder)
    };
  }

  constructor(filePath) {
    this.filePath = filePath;
  }

  exists() {
    return fs.existsSync(this.filePath);
  }

  load() {
    if (!this.exists()) return Profile.defaults();
    const onDisk = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    return { ...Profile.defaults(), ...onDisk };
  }

  save(profile) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(profile, null, 2));
  }

  update(patch) {
    const next = { ...this.load(), ...patch };
    this.save(next);
    return next;
  }
}

module.exports = { Profile };
