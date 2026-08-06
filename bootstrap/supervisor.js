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

/**
 * `onGiveUp`/`onHealthyRun` are how this stays "dead simple, automated,
 * rock solid" for someone who can't be asked to run a diagnostic script
 * by hand (Seth, 2026-08-05) - see bootstrap/diagnostics.js for what each
 * actually does. Both default to a no-op so existing tests (and anything
 * that doesn't care about diagnostics) are unaffected; the real ones are
 * wired in below, outside of tests. Failures in either are caught and
 * logged, never allowed to break the actual supervise/restart loop -
 * failing to report a failure must never itself become a second failure.
 */
async function runSupervisorLoop({ spawnChild, sleep, log, now, onGiveUp = async () => {}, onHealthyRun = async () => {} }) {
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
      try {
        await onGiveUp({ failCount, ranMs });
      } catch (err) {
        log(`onGiveUp itself failed: ${err.message}`);
      }
      return { gaveUp: true, failCount };
    }

    if (decision.delayMs === 0) {
      // A genuinely healthy run, not just backing off before another
      // attempt - the moment things are known to be working is exactly
      // when a previously undelivered report (see diagnostics.js) has
      // its best chance of actually getting out.
      try {
        await onHealthyRun({ ranMs });
      } catch (err) {
        log(`onHealthyRun itself failed: ${err.message}`);
      }
    } else {
      log(`backing off ${decision.delayMs}ms before restart (fast failure #${failCount})`);
    }
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
    // Regression (2026-08-05, real machine): 'exit' fires the moment the
    // OS reports the process gone, which is NOT guaranteed to be after its
    // stdout/stderr pipes have finished draining - a stack trace printed
    // right as the process dies (exactly the case we most need to catch)
    // can still be in flight and get lost. 'close' fires only after the
    // child's stdio streams have themselves ended, so nothing gets cut off.
    // Confirmed live: this exact gap is why a captured log showed a clean
    // "server listening" line and then nothing at all for a process that
    // still exited with code 1 moments later.
    let exitCode = 0;
    child.on('exit', (code) => {
      exitCode = code ?? 0;
    });
    child.on('close', () => {
      logStream.end(() => resolve(exitCode));
    });
  });
}

function realLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.mkdirSync(path.dirname(CRASH_LOOP_LOG), { recursive: true });
  fs.appendFileSync(CRASH_LOOP_LOG, line);
  console.log(msg);
}

function realOnGiveUp({ failCount }) {
  const { collectDiagnosticReport, deliverDiagnosticReport } = require('./diagnostics');
  const report = collectDiagnosticReport();
  return deliverDiagnosticReport(report, { reason: `gave up after ${failCount} fast failures`, log: realLog });
}

function realOnHealthyRun() {
  const { retryPendingReport } = require('./diagnostics');
  return retryPendingReport({ log: realLog });
}

if (require.main === module) {
  runSupervisorLoop({
    spawnChild: realSpawnChild,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: realLog,
    now: () => Date.now(),
    onGiveUp: realOnGiveUp,
    onHealthyRun: realOnHealthyRun,
  });
}

module.exports = { decideNextAction, runSupervisorLoop };
