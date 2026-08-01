'use strict';

/**
 * Resolves the real Google account behind whatever Drive client this
 * ToolSet is running as — the user every invoke() is made "in the
 * context of" (see ToolSet.invoke), regardless of whether today's
 * deployment model is one account per process or, eventually, several
 * per shared server. Falls back to the local instance's own displayName
 * (no photo) if Drive isn't set up yet or the whoami call fails for any
 * reason — request attribution must never hard-depend on Drive.
 */
async function resolveIdentity({ toolSet, instanceId, displayName, secretStore }) {
  // Critical: never attempt whoami unless a refresh token already exists.
  // Calling the drive tool when Drive has never been set up doesn't fail
  // fast — it launches a real interactive OAuth consent flow (opens a
  // browser, waits indefinitely for a callback), which would otherwise
  // fire as a silent side effect of invoking ANY tool at all.
  if (!toolSet.has('drive') || !secretStore?.has('google_oauth_refresh_token')) {
    return { instanceId, displayName, photoLink: undefined, emailAddress: undefined };
  }
  try {
    const who = await toolSet.get('drive').invoke({ action: 'whoami' });
    return {
      instanceId,
      displayName: who.result.displayName || displayName,
      photoLink: who.result.photoLink,
      emailAddress: who.result.emailAddress,
    };
  } catch {
    return { instanceId, displayName, photoLink: undefined, emailAddress: undefined };
  }
}

module.exports = { resolveIdentity };
