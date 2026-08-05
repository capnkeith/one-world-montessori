#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('../src/core/paths');

// Replaces the old auto-start-loop.bat's bare `:loop / timeout 5 / goto
// loop`, which retried a crashing child every 5 seconds forever with no
// backoff and no circuit breaker. That let a fast-failing boot-launcher.js
// (e.g. one that opens a real OAuth consent browser window on every
// attempt) get relaunched dozens of times a minute until the browser fell
// over. This supervisor still restarts a legitimately-crashing child, but
// backs off exponentially and eventually gives up rather than hammering
// the machine forever.

const BOOT_LAUNCHER = path.join(__dirname, 'boot-launcher.js');
const CRASH_LOOP_LOG = path.join(paths.STATE_ROOT, 'supervisor.log');
// Regression (2026-08-05, real machine): `stdio: 'inherit'` sends the
// child's real stdout/stderr - the one thing that would actually explain
// *why* it exited, not just that it did - straight to this process's own
// stdio. That's fine when launched from a visible console, but this runs
// headless (hidden window / Task Scheduler with no console at all) on
// every real install, so the one piece of information anyone would need
// to diagnose a crash was going nowhere. Captured to a plain file instead.
const CHILD_OUTPUT_LOG = path.join(paths.STATE_ROOT, 'child-output.log');

const HEALTHY_RUN_MS = 60_000; // ran at least this long => treat as a normal exit, not a crash
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_FAST_FAILURES = 6; // give up after this many fast failures in a row

/**
 * Pure decision logic — no spawning, no timers — so the backoff/give-up
 * behavior is testable without a real child process. `ranMs` is how long
 * the previous child stayed up; `failCount` is the number of consecutive
 * fast failures *before* this run.
 */
function decideNextAction({ ranMs, failCount }) {
  if (ranMs >= HEALTHY_RUN_MS) {
    return { action: 'restart', delayMs: 0, failCount: 0 };
  }
  const nextFailCount = failCount + 1;
  if (nextFailCount >= MAX_FAST_FAILURES) {
    return { action: 'giveUp', failCount: nextFailCount };
  }
  const delayMs = Math.min(BASE_BACKOFF_MS * 2 ** (nextFailCount - 1), MAX_BACKOFF_MS);
  return { action: 'restart', delayMs, failCount: nextFailCount };
}

async function runSupervisorLoop({ spawnChild, sleep, log, now }) {
  let failCount = 0;
  for (;;) {
    const startedAt = now();
    const exitCode = await spawnChild();
    const ranMs = now() - startedAt;
    log(`child exited (code=${exitCode}, ranMs=${ranMs})`);

    const decision = decideNextAction({ ranMs, failCount });
    failCount = decision.failCount;

    if (decision.action === 'giveUp') {
      log(
        `${failCount} fast failures in a row (child never stayed up ${HEALTHY_RUN_MS}ms) — ` +
          'giving up, not retrying. Fix the underlying issue and restart the supervisor manually.'
      );
      return { gaveUp: true, failCount };
    }

    if (decision.delayMs > 0) log(`backing off ${decision.delayMs}ms before restart (fast failure #${failCount})`);
    await sleep(decision.delayMs);
  }
}

function realSpawnChild() {
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(CHILD_OUTPUT_LOG), { recursive: true });
    const logStream = fs.createWriteStream(CHILD_OUTPUT_LOG, { flags: 'a' });
    logStream.write(`\n[${new Date().toISOString()}] --- starting boot-launcher.js ---\n`);
    const child = spawn(process.execPath, [BOOT_LAUNCHER], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });
    child.on('exit', (code) => {
      logStream.end();
      resolve(code ?? 0);
    });
  });
}

function realLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.mkdirSync(path.dirname(CRASH_LOOP_LOG), { recursive: true });
  fs.appendFileSync(CRASH_LOOP_LOG, line);
  console.log(msg);
}

if (require.main === module) {
  runSupervisorLoop({
    spawnChild: realSpawnChild,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: realLog,
    now: () => Date.now(),
  });
}

module.exports = { decideNextAction, runSupervisorLoop };
