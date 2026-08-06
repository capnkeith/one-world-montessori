'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  collectDiagnosticReport,
  sendDiagnosticReport,
  deliverDiagnosticReport,
  retryPendingReport,
} = require('../bootstrap/diagnostics');

test('collectDiagnosticReport assembles every section from injected data, none of it hardcoded', () => {
  const report = collectDiagnosticReport({
    getSecurityStatus: () => ({ SmartAppControlState: 'Off', RealTimeProtectionEnabled: true, AntivirusEnabled: true }),
    getRecentDetections: () => [{ InitialDetectionTime: '2026-08-05T00:00:00Z', ThreatName: 'Test.Threat', ActionSuccess: true }],
    getInstalledCommit: () => 'abc123 a real commit message',
    getGitVersion: () => 'git version 2.55.0',
    readTail: (filePath) => (filePath.includes('supervisor.log') ? 'line one\nline two' : filePath.includes('child-output.log') ? 'child line' : null),
    hostname: 'TEST-MACHINE',
    username: 'testuser',
    nodeVersion: 'v24.0.0',
    osType: 'Windows_NT',
    osRelease: '10.0.26200',
    stateRoot: 'C:\\fake\\.owm-mcp',
    now: () => new Date('2026-08-05T12:00:00Z'),
  });

  assert.match(report, /OWM Drive - automatic diagnostic report/);
  assert.match(report, /Generated: 2026-08-05T12:00:00\.000Z/);
  assert.match(report, /Machine: TEST-MACHINE \(user: testuser\)/);
  assert.match(report, /Windows: Windows_NT 10\.0\.26200/);
  assert.match(report, /Smart App Control: Off/);
  assert.match(report, /Real-time protection enabled: true/);
  assert.match(report, /2026-08-05T00:00:00Z - Test\.Threat - resolved: true/);
  assert.match(report, /Current install commit: abc123 a real commit message/);
  assert.match(report, /last 40 lines of supervisor\.log/);
  assert.match(report, /line one\nline two/);
  assert.match(report, /last 400 lines of child-output\.log/);
  assert.match(report, /child line/);
  assert.match(report, /node: v24\.0\.0/);
  assert.match(report, /git: git version 2\.55\.0/);
});

test('collectDiagnosticReport handles a Windows Security read failure without throwing', () => {
  const report = collectDiagnosticReport({
    getSecurityStatus: () => ({ error: 'access denied' }),
    getRecentDetections: () => [],
    getInstalledCommit: () => 'unknown',
    getGitVersion: () => 'not found',
    readTail: () => null,
  });
  assert.match(report, /Could not read: access denied/);
  assert.match(report, /None found\./);
  assert.match(report, /No supervisor\.log found\./);
  assert.doesNotMatch(report, /child-output\.log/, 'must omit the child-output.log section entirely when the file does not exist, not print an empty one');
});

test('sendDiagnosticReport sends exactly once when the first attempt succeeds', async () => {
  const calls = [];
  await sendDiagnosticReport('a report', {
    hostname: 'TEST-MACHINE',
    reason: 'unit test',
    invokeMail: async (params) => calls.push(params),
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].action, 'send');
  assert.strictEqual(calls[0].to, 'seth@oneworldmontessori.org');
  assert.match(calls[0].subject, /OWM Drive automatic diagnostic report - TEST-MACHINE \(unit test\)/);
  assert.strictEqual(calls[0].text, 'a report');
});

test('sendDiagnosticReport retries on failure and succeeds once a later attempt works', async () => {
  let callCount = 0;
  const sleeps = [];
  await sendDiagnosticReport('a report', {
    attempts: 3,
    delayMs: 1234,
    sleep: async (ms) => sleeps.push(ms),
    invokeMail: async () => {
      callCount += 1;
      if (callCount < 3) throw new Error('transient network blip');
    },
  });
  assert.strictEqual(callCount, 3);
  assert.deepStrictEqual(sleeps, [1234, 1234], 'must sleep between attempts, but not after the final one');
});

test('sendDiagnosticReport throws the last error once every attempt has failed', async () => {
  let callCount = 0;
  await assert.rejects(
    () =>
      sendDiagnosticReport('a report', {
        attempts: 2,
        delayMs: 0,
        sleep: async () => {},
        invokeMail: async () => {
          callCount += 1;
          throw new Error(`failure #${callCount}`);
        },
      }),
    /failure #2/
  );
  assert.strictEqual(callCount, 2);
});

test('sendDiagnosticReport treats a hung send as a failure rather than hanging forever', async () => {
  await assert.rejects(
    () =>
      sendDiagnosticReport('a report', {
        attempts: 1,
        attemptTimeoutMs: 20,
        invokeMail: () => new Promise(() => {}), // never resolves
      }),
    /timed out/
  );
});

test('deliverDiagnosticReport writes to disk before attempting to send, and removes it once sent successfully', async () => {
  const written = {};
  const removed = [];
  const logs = [];

  const result = await deliverDiagnosticReport('a report', {
    pendingReportPath: '/fake/pending.txt',
    writeFile: (p, content) => {
      written[p] = content;
    },
    removeFile: (p) => removed.push(p),
    log: (msg) => logs.push(msg),
    invokeMail: async () => {},
  });

  assert.strictEqual(result.sent, true);
  assert.strictEqual(written['/fake/pending.txt'], 'a report', 'must be saved to disk before the send is even attempted');
  assert.deepStrictEqual(removed, ['/fake/pending.txt']);
  assert.ok(logs.some((l) => l.includes('sent successfully')));
});

test('deliverDiagnosticReport leaves the report on disk (never removes it) when every send attempt fails', async () => {
  const removed = [];
  const logs = [];

  const result = await deliverDiagnosticReport('a report', {
    pendingReportPath: '/fake/pending.txt',
    writeFile: () => {},
    removeFile: (p) => removed.push(p),
    log: (msg) => logs.push(msg),
    attempts: 1,
    invokeMail: async () => {
      throw new Error('no network');
    },
  });

  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.error, 'no network');
  assert.deepStrictEqual(removed, [], 'a failed send must never delete the durable copy - that would lose the report entirely');
  assert.ok(logs.some((l) => l.includes('could not be sent') && l.includes('left on disk')));
});

test('retryPendingReport does nothing (and reports as much) when there is no pending report', async () => {
  const result = await retryPendingReport({
    fileExists: () => false,
    invokeMail: async () => {
      throw new Error('must never be called');
    },
  });
  assert.deepStrictEqual(result, { attempted: false });
});

test('retryPendingReport sends and clears a genuinely pending report once things are healthy again', async () => {
  const removed = [];
  const calls = [];
  const result = await retryPendingReport({
    fileExists: () => true,
    readFile: () => 'the previously undelivered report',
    removeFile: (p) => removed.push(p),
    pendingReportPath: '/fake/pending.txt',
    invokeMail: async (params) => calls.push(params),
  });

  assert.deepStrictEqual(result, { attempted: true, sent: true });
  assert.deepStrictEqual(removed, ['/fake/pending.txt']);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].text, 'the previously undelivered report');
  assert.match(calls[0].subject, /retry of a previously undelivered report/);
});

test('retryPendingReport leaves the pending report in place if this retry also fails', async () => {
  const removed = [];
  const result = await retryPendingReport({
    fileExists: () => true,
    readFile: () => 'still stuck',
    removeFile: (p) => removed.push(p),
    attempts: 1,
    invokeMail: async () => {
      throw new Error('still no network');
    },
  });

  assert.deepStrictEqual(result, { attempted: true, sent: false, error: 'still no network' });
  assert.deepStrictEqual(removed, []);
});
