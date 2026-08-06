#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');
const paths = require('../src/core/paths');

/**
 * Automatic diagnostic collection + delivery — no user action required at
 * all (Seth, 2026-08-05: "a one click diagnostic retrieval system with no
 * user intervention" — then, more bluntly, "these are teachers so just
 * asking them to paste into PowerShell is a bridge too far... dead simple
 * automated and rock solid"). Wired into supervisor.js's own give-up path
 * (see runSupervisorLoop's onGiveUp hook): the moment a machine gives up
 * retrying, it collects this report and emails it, entirely on its own.
 *
 * Delivery is in-process (createContext + toolSet.invoke('mail', ...)),
 * deliberately never routed through this machine's own local HTTP server
 * (see TODO.md's "known gap" note, 2026-08-05) — that's exactly the thing
 * under diagnosis, and depending on it to report its own failure is
 * backwards. This only needs cached Gmail credentials + real network
 * access, neither of which depends on http-server.js at all.
 *
 * "Rock solid" specifically means: this must not lose a report just
 * because the send failed once. deliverDiagnosticReport writes the report
 * to disk *before* attempting delivery, retries a few times with a short
 * delay, and — if every attempt still fails — leaves it on disk rather
 * than discarding it. retryPendingReport, called on every healthy run (see
 * supervisor.js's onHealthyRun hook), picks that back up automatically the
 * next time things are working well enough to actually send it.
 *
 * Every real side effect is injected so both the report-text assembly and
 * the delivery/retry orchestration are testable without a real Windows
 * machine, git binary, filesystem state, or Gmail credentials — see each
 * function's defaults for the real implementations, wired in automatically
 * outside of tests.
 */

const PENDING_REPORT_PATH = path.join(paths.STATE_ROOT, 'pending-diagnostic-report.txt');

/**
 * Runs a PowerShell script via a temp .ps1 *file*, never an inline
 * -Command string - nesting $_ / quoted script blocks inside a single
 * shell-escaped string (itself then re-escaped by cmd.exe, which is what
 * execSync shells out through on Windows) is real quoting hell with no
 * good way to test it outside of a live Windows box. A temp file sidesteps
 * that entirely: the script content is written verbatim, no escaping.
 */
function runPowerShellScript(scriptContent) {
  const scriptPath = path.join(os.tmpdir(), `owm-diagnostics-${crypto.randomUUID()}.ps1`);
  fs.writeFileSync(scriptPath, scriptContent, 'utf8');
  try {
    const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || `powershell exited with status ${result.status}`);
    return result.stdout;
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
}

function realGetSecurityStatus() {
  try {
    const out = runPowerShellScript('Get-MpComputerStatus | Select-Object SmartAppControlState,RealTimeProtectionEnabled,AntivirusEnabled | ConvertTo-Json');
    return JSON.parse(out);
  } catch (err) {
    return { error: err.message };
  }
}

// ThreatName does not exist on Get-MpThreatDetection's own output (real
// bug, confirmed live: silently comes back null, Select-Object does not
// error on a missing property) - the real name needs a Get-MpThreat
// lookup by ThreatID. Also explicitly formats InitialDetectionTime as
// ISO-8601 before JSON conversion: Windows PowerShell 5.1's ConvertTo-Json
// serializes raw [DateTime] values using the legacy ASP.NET
// "/Date(ticks)/" format, not a readable string, confirmed live as well.
const RECENT_DETECTIONS_SCRIPT = `
Get-MpThreatDetection | Sort-Object InitialDetectionTime -Descending | Select-Object -First 10 | ForEach-Object {
  $threatName = try { (Get-MpThreat -ThreatID $_.ThreatID -ErrorAction Stop).ThreatName } catch { "ThreatID $($_.ThreatID)" }
  [PSCustomObject]@{
    InitialDetectionTime = $_.InitialDetectionTime.ToString('o')
    ThreatName = $threatName
    ActionSuccess = $_.ActionSuccess
  }
} | ConvertTo-Json
`;

function realGetRecentDetections() {
  try {
    const out = runPowerShellScript(RECENT_DETECTIONS_SCRIPT);
    if (!out || !out.trim()) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function realGetInstalledCommit() {
  try {
    return execSync(`git -C "${paths.CURRENT_LINK}" log -1 --oneline`, { encoding: 'utf8', timeout: 10_000 }).trim();
  } catch (err) {
    return `(could not read: ${err.message})`;
  }
}

function realGetGitVersion() {
  try {
    return execSync('git --version', { encoding: 'utf8', timeout: 10_000 }).trim();
  } catch {
    return 'not found';
  }
}

function realReadTail(filePath, maxLines) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  const allLines = content.split(/\r?\n/);
  return allLines.slice(-maxLines).join('\n');
}

/**
 * Pure assembly logic - every real-world lookup above is injected, so
 * this is fully testable against fakes. Returns the plain-text report
 * (same shape a human previously had to paste by hand via diagnose.ps1).
 */
function collectDiagnosticReport({
  getSecurityStatus = realGetSecurityStatus,
  getRecentDetections = realGetRecentDetections,
  getInstalledCommit = realGetInstalledCommit,
  getGitVersion = realGetGitVersion,
  readTail = realReadTail,
  hostname = os.hostname(),
  username = os.userInfo().username,
  nodeVersion = process.version,
  osType = os.type(),
  osRelease = os.release(),
  stateRoot = paths.STATE_ROOT,
  now = () => new Date(),
} = {}) {
  const lines = [];
  const add = (text = '') => lines.push(text);

  add('==================================================');
  add('  OWM Drive - automatic diagnostic report');
  add('==================================================');
  add('');
  add(`Generated: ${now().toISOString()}`);
  add(`Machine: ${hostname} (user: ${username})`);
  add(`Windows: ${osType} ${osRelease}`);

  add('');
  add('[Windows Security]');
  const security = getSecurityStatus();
  if (security.error) {
    add(`Could not read: ${security.error}`);
  } else {
    add(`Smart App Control: ${security.SmartAppControlState}`);
    add(`Real-time protection enabled: ${security.RealTimeProtectionEnabled}`);
    add(`Antivirus enabled: ${security.AntivirusEnabled}`);
  }

  add('');
  add('[Recent Windows Security detections/blocks (last 10)]');
  const detections = getRecentDetections();
  if (detections.length === 0) {
    add('None found.');
  } else {
    for (const t of detections) add(`${t.InitialDetectionTime} - ${t.ThreatName} - resolved: ${t.ActionSuccess}`);
  }

  add('');
  add('[OWM Drive install state]');
  add(`Found: ${stateRoot}`);
  add(`Current install commit: ${getInstalledCommit()}`);

  const supervisorTail = readTail(path.join(stateRoot, 'supervisor.log'), 40);
  if (supervisorTail !== null) {
    add('');
    add('--- last 40 lines of supervisor.log ---');
    add(supervisorTail);
  } else {
    add('');
    add('No supervisor.log found.');
  }

  const childTail = readTail(path.join(stateRoot, 'child-output.log'), 400);
  if (childTail !== null) {
    add('');
    add('--- last 400 lines of child-output.log ---');
    add(childTail);
  }

  add('');
  add('[Node / Git]');
  add(`node: ${nodeVersion}`);
  add(`git: ${getGitVersion()}`);

  add('');
  add('---------------------------------------------------');
  return lines.join('\n');
}

/** In-process mail send - see this file's header on why this never touches the local HTTP server. */
async function realInvokeMail(params) {
  const { createContext } = require('../src/context');
  const { toolSet } = createContext();
  return toolSet.invoke('mail', params);
}

/** One attempt, bounded so a hung network call can never hang the caller (supervisor.js's own loop) indefinitely. */
async function attemptSend(report, { to, reason, hostname, invokeMail, attemptTimeoutMs }) {
  const subject = `OWM Drive automatic diagnostic report - ${hostname}${reason ? ` (${reason})` : ''}`;
  // Plain Promise.race would leave the loser's timer running for its full
  // duration even after the other side already won - in a long-lived
  // process like supervisor.js, every successful send would leak one more
  // live timer forever. Cleared explicitly regardless of which side wins.
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`diagnostic report send timed out after ${attemptTimeoutMs}ms`)), attemptTimeoutMs);
  });
  try {
    await Promise.race([invokeMail({ action: 'send', to, subject, text: report }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retries a few times with a short delay before giving up on *this*
 * attempt - real, transient network blips are common right after a crash,
 * not a reason to immediately fall back to "undeliverable."
 */
async function sendDiagnosticReport(
  report,
  {
    to = 'seth@oneworldmontessori.org',
    reason = '',
    hostname = os.hostname(),
    invokeMail = realInvokeMail,
    attempts = 3,
    delayMs = 3_000,
    attemptTimeoutMs = 15_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}
) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await attemptSend(report, { to, reason, hostname, invokeMail, attemptTimeoutMs });
      return;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastErr;
}

/**
 * The durable half of "rock solid": save first, then try to send. A
 * failed send never loses the report - it's still on disk for
 * retryPendingReport to pick up later. On success, the pending file is
 * removed so it isn't resent forever.
 */
async function deliverDiagnosticReport(
  report,
  { pendingReportPath = PENDING_REPORT_PATH, writeFile = fs.writeFileSync, removeFile = fs.rmSync, log = () => {}, ...sendOpts } = {}
) {
  writeFile(pendingReportPath, report);
  try {
    await sendDiagnosticReport(report, sendOpts);
    removeFile(pendingReportPath, { force: true });
    log('diagnostic report sent successfully.');
    return { sent: true };
  } catch (err) {
    log(`diagnostic report could not be sent (left on disk for the next healthy run to retry): ${err.message}`);
    return { sent: false, error: err.message };
  }
}

/**
 * Called on a healthy run (see supervisor.js's onHealthyRun hook) - if a
 * previous give-up's report never made it out, this is what actually
 * satisfies "no user intervention": nobody has to notice or ask again,
 * the next time things are working well enough to send it, it just goes.
 */
async function retryPendingReport({
  pendingReportPath = PENDING_REPORT_PATH,
  fileExists = fs.existsSync,
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  removeFile = fs.rmSync,
  log = () => {},
  ...sendOpts
} = {}) {
  if (!fileExists(pendingReportPath)) return { attempted: false };
  const report = readFile(pendingReportPath);
  try {
    await sendDiagnosticReport(report, { reason: 'retry of a previously undelivered report', ...sendOpts });
    removeFile(pendingReportPath, { force: true });
    log('previously undelivered diagnostic report sent successfully.');
    return { attempted: true, sent: true };
  } catch (err) {
    log(`retry of the pending diagnostic report still failed, leaving it on disk: ${err.message}`);
    return { attempted: true, sent: false, error: err.message };
  }
}

module.exports = {
  PENDING_REPORT_PATH,
  collectDiagnosticReport,
  sendDiagnosticReport,
  deliverDiagnosticReport,
  retryPendingReport,
};

if (require.main === module) {
  (async () => {
    const report = collectDiagnosticReport();
    console.log(report);
    const result = await deliverDiagnosticReport(report, { reason: process.argv[2], log: console.log });
    process.exitCode = result.sent ? 0 : 1;
  })();
}
