#!/usr/bin/env node

/**
 * Automated tests for the Bug Bridge native host.
 *
 * Tests protocol, queue, file-writer, prompt-generator, daemon-client, and host.js e2e.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const protocol = require('./lib/protocol');
const queue = require('./lib/queue');
const fileWriter = require('./lib/file-writer');
const promptGenerator = require('./lib/prompt-generator');
const daemonClient = require('./lib/daemon-client');

let passed = 0;
let failed = 0;
const failures = [];

/**
 * Asserts a condition is true.
 * @param {boolean} condition
 * @param {string} message
 */
function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  \u2717 ${message}`);
  }
}

/**
 * Creates a temporary test directory.
 * @returns {string} Path to temp directory
 */
function createTempDir() {
  const dir = path.join('/tmp', `bug-bridge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Removes a directory recursively.
 * @param {string} dir - Directory to remove
 */
function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    // Ignore
  }
}

/**
 * Creates a minimal mock bundle for testing.
 * @param {string} repoPath - Repo path to use
 * @returns {object} Mock bundle
 */
function createMockBundle(repoPath) {
  // Create a tiny 1x1 white PNG as base64
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
  const dataUrl = `data:image/png;base64,${pngBase64}`;

  return {
    version: '1',
    repo_path: repoPath,
    screenshot_raw: dataUrl,
    screenshot_annotated: dataUrl,
    description: 'The submit button does not work when clicked. It should submit the form but nothing happens.',
    console_errors: [
      {
        level: 'error',
        message: 'TypeError: Cannot read properties of undefined',
        stack: 'at handleSubmit (app.js:42)\nat HTMLButtonElement.onclick (index.html:15)',
        timestamp: '2026-02-25T14:30:00.000Z',
        source: 'app.js',
        line: 42,
        column: 12
      },
      {
        level: 'warn',
        message: 'Deprecated API usage detected',
        stack: null,
        timestamp: '2026-02-25T14:29:55.000Z',
        source: 'vendor.js',
        line: 100,
        column: 5
      }
    ],
    network_har: {
      log: {
        version: '1.2',
        creator: { name: 'Bug Bridge', version: '0.1.0' },
        entries: [
          {
            request: { method: 'GET', url: 'https://example.com/api/data', headers: [] },
            response: { status: 200, statusText: 'OK', headers: [] },
            time: 45
          },
          {
            request: { method: 'POST', url: 'https://example.com/api/submit', headers: [] },
            response: { status: 500, statusText: 'Internal Server Error', headers: [] },
            time: 120
          }
        ]
      }
    },
    network_errors_only: [
      {
        request: { method: 'POST', url: 'https://example.com/api/submit', headers: [] },
        response: { status: 500, statusText: 'Internal Server Error', headers: [] },
        time: 120
      }
    ],
    cookies: [
      { name: 'session_id', value: 'abc123', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' },
      { name: 'theme', value: 'dark', domain: 'example.com', path: '/', secure: false, httpOnly: false, sameSite: 'None' }
    ],
    page_source: '<!DOCTYPE html><html><head><title>Test Page</title></head><body><h1>Hello</h1></body></html>',
    meta: {
      url: 'https://example.com/dashboard',
      title: 'Dashboard — Example App',
      timestamp: '2026-02-25T14:30:22.000Z',
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0',
      screenResolution: { width: 2560, height: 1440 },
      devicePixelRatio: 2
    }
  };
}

// ============================================================
// Test: protocol.js
// ============================================================

function testProtocol() {
  console.log('\n=== Testing protocol.js ===');

  const testMessage = { action: 'ping', version: '0.1.0' };

  // Test encodeMessage + decodeMessage
  const encoded = protocol.encodeMessage(testMessage);
  assert(encoded.length > 4, 'encodeMessage produces buffer longer than 4 bytes');

  const length = encoded.readUInt32LE(0);
  const jsonPart = encoded.slice(4).toString('utf8');
  assert(length === Buffer.byteLength(jsonPart, 'utf8'), 'Length prefix matches JSON byte length');

  const decoded = protocol.decodeMessage(encoded);
  assert(decoded.action === 'ping', 'decodeMessage recovers action field');
  assert(decoded.version === '0.1.0', 'decodeMessage recovers version field');

  // Test with larger message
  const largeMessage = { data: 'x'.repeat(10000) };
  const largeEncoded = protocol.encodeMessage(largeMessage);
  const largeDecoded = protocol.decodeMessage(largeEncoded);
  assert(largeDecoded.data.length === 10000, 'Large message roundtrips correctly');

  // Test decode error with too-small buffer
  try {
    protocol.decodeMessage(Buffer.alloc(2));
    assert(false, 'decodeMessage throws on too-small buffer');
  } catch (err) {
    assert(true, 'decodeMessage throws on too-small buffer');
  }
}

// ============================================================
// Test: queue.js
// ============================================================

function testQueue() {
  console.log('\n=== Testing queue.js ===');

  const tempDir = createTempDir();

  try {
    // Test enqueue
    const entry1 = queue.enqueue(tempDir, {
      id: '2026-02-25-140000',
      dir: path.join(tempDir, '.bug-reports', '2026-02-25-140000'),
      description_preview: 'First bug report',
      url: 'https://example.com/page1'
    });
    assert(entry1.status === 'pending', 'enqueue sets status to pending');
    assert(entry1.queued_at !== null, 'enqueue sets queued_at');

    const entry2 = queue.enqueue(tempDir, {
      id: '2026-02-25-140100',
      dir: path.join(tempDir, '.bug-reports', '2026-02-25-140100'),
      description_preview: 'Second bug report',
      url: 'https://example.com/page2'
    });

    const entry3 = queue.enqueue(tempDir, {
      id: '2026-02-25-140200',
      dir: path.join(tempDir, '.bug-reports', '2026-02-25-140200'),
      description_preview: 'Third bug report',
      url: 'https://example.com/page3'
    });

    // Test getQueue
    const q = queue.getQueue(tempDir);
    assert(q.reports.length === 3, 'getQueue returns all 3 entries');

    // Test FIFO order
    const next1 = queue.getNext(tempDir);
    assert(next1.id === '2026-02-25-140000', 'getNext returns first entry (FIFO)');

    // Test markProcessing
    queue.markProcessing(tempDir, '2026-02-25-140000');
    const next2 = queue.getNext(tempDir);
    assert(next2.id === '2026-02-25-140100', 'getNext skips processing entry');

    // Test getActive
    const active = queue.getActive(tempDir);
    assert(active !== null && active.id === '2026-02-25-140000', 'getActive returns the processing entry');

    // Test getPending
    const pending = queue.getPending(tempDir);
    assert(pending.length === 2, 'getPending returns 2 pending entries');

    // Test markComplete
    queue.markComplete(tempDir, '2026-02-25-140000');
    const activeAfter = queue.getActive(tempDir);
    assert(activeAfter === null, 'getActive returns null after markComplete');

    // Test markFailed
    queue.markFailed(tempDir, '2026-02-25-140100', 'Test error');
    const q2 = queue.getQueue(tempDir);
    const failedEntry = q2.reports.find(r => r.id === '2026-02-25-140100');
    assert(failedEntry.status === 'failed', 'markFailed sets status to failed');
    assert(failedEntry.error === 'Test error', 'markFailed sets error message');

    // Verify queue file is valid JSON
    const queuePath = path.join(tempDir, '.bug-reports', 'queue.json');
    const rawJson = fs.readFileSync(queuePath, 'utf8');
    try {
      JSON.parse(rawJson);
      assert(true, 'queue.json is valid JSON');
    } catch (err) {
      assert(false, 'queue.json is valid JSON');
    }

    // Verify pretty-printed
    assert(rawJson.includes('\n'), 'queue.json is pretty-printed');

    // Completed/failed entries preserved
    const q3 = queue.getQueue(tempDir);
    assert(q3.reports.length === 3, 'Completed/failed entries are preserved in queue');
  } finally {
    cleanupDir(tempDir);
  }
}

// ============================================================
// Test: file-writer.js
// ============================================================

function testFileWriter() {
  console.log('\n=== Testing file-writer.js ===');

  const tempDir = createTempDir();

  try {
    const bundle = createMockBundle(tempDir);
    const result = fileWriter.writeBundle(bundle);

    assert(result.dir.startsWith(path.join(tempDir, '.bug-reports')), 'Report dir is under .bug-reports');
    assert(result.filesWritten > 0, `Files written: ${result.filesWritten}`);
    assert(result.errors.length === 0, 'No write errors');

    // Check each file exists
    const files = fs.readdirSync(result.dir);
    assert(files.includes('screenshot-raw.png'), 'screenshot-raw.png exists');
    assert(files.includes('screenshot-annotated.png'), 'screenshot-annotated.png exists');
    assert(files.includes('description.txt'), 'description.txt exists');
    assert(files.includes('console-errors.json'), 'console-errors.json exists');
    assert(files.includes('network-full.har'), 'network-full.har exists');
    assert(files.includes('network-errors.json'), 'network-errors.json exists');
    assert(files.includes('cookies.json'), 'cookies.json exists');
    assert(files.includes('page-source.html'), 'page-source.html exists');
    assert(files.includes('meta.json'), 'meta.json exists');
    assert(files.includes('manifest.json'), 'manifest.json exists');

    // Check PNG files are valid (start with PNG magic bytes)
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const rawPng = fs.readFileSync(path.join(result.dir, 'screenshot-raw.png'));
    assert(rawPng.slice(0, 4).equals(pngMagic), 'screenshot-raw.png is a valid PNG');

    // Check JSON files are valid
    const consoleErrors = JSON.parse(fs.readFileSync(path.join(result.dir, 'console-errors.json'), 'utf8'));
    assert(Array.isArray(consoleErrors) && consoleErrors.length === 2, 'console-errors.json has 2 entries');

    const har = JSON.parse(fs.readFileSync(path.join(result.dir, 'network-full.har'), 'utf8'));
    assert(har.log && har.log.version === '1.2', 'network-full.har has correct HAR format');

    const cookies = JSON.parse(fs.readFileSync(path.join(result.dir, 'cookies.json'), 'utf8'));
    assert(cookies.length === 2, 'cookies.json has 2 entries');

    const meta = JSON.parse(fs.readFileSync(path.join(result.dir, 'meta.json'), 'utf8'));
    assert(meta.url === 'https://example.com/dashboard', 'meta.json has correct URL');

    const description = fs.readFileSync(path.join(result.dir, 'description.txt'), 'utf8');
    assert(description.includes('submit button'), 'description.txt has correct content');

    const pageSource = fs.readFileSync(path.join(result.dir, 'page-source.html'), 'utf8');
    assert(pageSource.includes('<!DOCTYPE html>'), 'page-source.html has HTML content');

    // Check manifest
    const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, 'manifest.json'), 'utf8'));
    assert(manifest.files && manifest.files.length > 0, 'manifest.json lists written files');
    assert(manifest.files.every(f => f.size > 0), 'All manifest files have size > 0');
  } finally {
    cleanupDir(tempDir);
  }
}

// ============================================================
// Test: prompt-generator.js
// ============================================================

function testPromptGenerator() {
  console.log('\n=== Testing prompt-generator.js ===');

  const tempDir = createTempDir();
  const reportDir = path.join(tempDir, '.bug-reports', '2026-02-25-143022');
  fs.mkdirSync(reportDir, { recursive: true });

  try {
    const bundle = createMockBundle(tempDir);
    const content = promptGenerator.generatePrompt(bundle, reportDir, tempDir);

    assert(content.includes('Dashboard — Example App'), 'Prompt includes page title');
    assert(content.includes('https://example.com/dashboard'), 'Prompt includes URL');
    assert(content.includes('1920x1080'), 'Prompt includes viewport');
    assert(content.includes('submit button'), 'Prompt includes user description');
    assert(content.includes('screenshot-annotated.png'), 'Prompt includes annotated screenshot reference');
    assert(content.includes('2 console errors/warnings'), 'Prompt includes correct error count');
    assert(content.includes('1 errors'), 'Prompt includes error count breakdown');
    assert(content.includes('1 warnings'), 'Prompt includes warning count breakdown');
    assert(content.includes('2 network requests'), 'Prompt includes request count');
    assert(content.includes('1 failed/errored'), 'Prompt includes error request count');
    assert(content.includes('2 cookies'), 'Prompt includes cookie count');
    assert(!content.includes('{'), 'No unfilled template variables (no { character in template sections)');
    assert(content.includes('.bug-reports/'), 'Prompt includes relative path');

    // Test without annotated screenshot
    const bundleNoAnnotation = { ...bundle, screenshot_annotated: null };
    const contentNoAnnotation = promptGenerator.generatePrompt(bundleNoAnnotation, reportDir, tempDir);
    assert(!contentNoAnnotation.includes('screenshot-annotated.png'), 'No annotated screenshot reference when null');

    // Write and verify
    promptGenerator.writePrompt(bundle, reportDir, tempDir);
    assert(fs.existsSync(path.join(reportDir, 'prompt.md')), 'prompt.md file was written');
  } finally {
    cleanupDir(tempDir);
  }
}

// ============================================================
// Test: daemon-client.js
// ============================================================

function testDaemonClient() {
  console.log('\n=== Testing daemon-client.js ===');

  // Test tmux detection
  const hasTmux = daemonClient.isTmuxInstalled();
  assert(typeof hasTmux === 'boolean', `tmux installed: ${hasTmux}`);

  // Test session name generation
  const sessionName1 = daemonClient.getTmuxSessionName('/Users/me/projects/my-app');
  assert(sessionName1 === 'bug-bridge-my-app', 'Session name from repo path');

  const sessionName2 = daemonClient.getTmuxSessionName('/var/repos/cool-project');
  assert(sessionName2 === 'bug-bridge-cool-project', 'Session name from different path');

  // Test attach command
  const cmd = daemonClient.getTmuxAttachCommand('/Users/me/projects/my-app');
  assert(cmd === 'tmux attach -t bug-bridge-my-app', 'Attach command is correct');

  // Test PID checking
  assert(daemonClient.isProcessAlive(process.pid) === true, 'Current process is alive');
  assert(daemonClient.isProcessAlive(99999999) === false, 'Non-existent PID is not alive');

  // Test getDaemonStatus with no daemon
  const tempDir = createTempDir();
  try {
    const status = daemonClient.getDaemonStatus(tempDir);
    assert(status.running === false, 'No daemon running in empty dir');
    assert(status.pid === null, 'No PID for empty dir');
    assert(status.queueLength === 0, 'Queue length 0 for empty dir');
    assert(status.activeReport === null, 'No active report for empty dir');
  } finally {
    cleanupDir(tempDir);
  }

  // Test stale PID detection
  const tempDir2 = createTempDir();
  try {
    const pidPath = path.join(tempDir2, '.bug-reports', '.daemon.pid');
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, '99999999', 'utf8'); // Stale PID
    const status = daemonClient.getDaemonStatus(tempDir2);
    assert(status.running === false, 'Stale PID detected as not running');
  } finally {
    cleanupDir(tempDir2);
  }

  // Test ensureDaemon without tmux
  if (!hasTmux) {
    const tempDir3 = createTempDir();
    try {
      const result = daemonClient.ensureDaemon(tempDir3, path.join(__dirname, 'daemon.js'));
      assert(result.success === false, 'ensureDaemon fails without tmux');
      assert(result.error && result.error.includes('tmux'), 'Error mentions tmux');
    } finally {
      cleanupDir(tempDir3);
    }
  }
}

// ============================================================
// Test: host.js end-to-end (ping)
// ============================================================

function testHostPing() {
  return new Promise((resolve) => {
    console.log('\n=== Testing host.js — ping ===');

    const hostPath = path.join(__dirname, 'host.js');
    const child = spawn(process.execPath, [hostPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const pingMessage = protocol.encodeMessage({ action: 'ping' });
    child.stdin.write(pingMessage);
    child.stdin.end();

    let stdout = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code) => {
      if (stderr) {
        console.log(`  stderr: ${stderr}`);
      }

      assert(code === 0, 'host.js exits with code 0 for ping');

      if (stdout.length >= 4) {
        try {
          const response = protocol.decodeMessage(stdout);
          assert(response.success === true, 'Ping response has success: true');
          assert(response.version === '0.1.0', 'Ping response has correct version');
        } catch (err) {
          assert(false, `Ping response parsing failed: ${err.message}`);
        }
      } else {
        assert(false, 'No response received from host.js');
      }

      resolve();
    });
  });
}

// ============================================================
// Test: host.js end-to-end (bug report)
// ============================================================

function testHostBugReport() {
  return new Promise((resolve) => {
    console.log('\n=== Testing host.js — bug report ===');

    const tempDir = createTempDir();
    const hostPath = path.join(__dirname, 'host.js');
    const bundle = createMockBundle(tempDir);

    const child = spawn(process.execPath, [hostPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const message = protocol.encodeMessage(bundle);
    child.stdin.write(message);
    child.stdin.end();

    let stdout = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code) => {
      if (stderr) {
        console.log(`  stderr: ${stderr}`);
      }

      assert(code === 0, 'host.js exits with code 0 for bug report');

      if (stdout.length >= 4) {
        try {
          const response = protocol.decodeMessage(stdout);
          assert(response.success === true, `Bug report response success: ${response.success} (error: ${response.error || 'none'})`);
          assert(response.report_dir && response.report_dir.includes('.bug-reports'), 'Response includes report_dir');
          assert(response.files_written > 0, `Files written: ${response.files_written}`);
          assert(typeof response.queue_position === 'number', `Queue position: ${response.queue_position}`);
          assert(response.daemon !== undefined, 'Response includes daemon info');

          // Verify files on disk
          if (response.report_dir && fs.existsSync(response.report_dir)) {
            const files = fs.readdirSync(response.report_dir);
            assert(files.includes('prompt.md'), 'prompt.md was generated');
            assert(files.includes('screenshot-raw.png'), 'screenshot-raw.png exists on disk');
            assert(files.includes('meta.json'), 'meta.json exists on disk');
          } else {
            assert(false, `Report dir does not exist: ${response.report_dir}`);
          }

          // Verify queue entry
          const q = queue.getQueue(tempDir);
          assert(q.reports.length === 1, 'Queue has 1 entry');
          // Note: status may be 'pending' or 'processing' if daemon picked it up quickly
          const validStatuses = ['pending', 'processing'];
          assert(validStatuses.includes(q.reports[0].status), `Queue entry status is valid: ${q.reports[0].status}`);
        } catch (err) {
          assert(false, `Bug report response parsing failed: ${err.message}`);
        }
      } else {
        assert(false, 'No response received from host.js');
      }

      cleanupDir(tempDir);
      resolve();
    });
  });
}

// ============================================================
// Test: host.js end-to-end (status)
// ============================================================

function testHostStatus() {
  return new Promise((resolve) => {
    console.log('\n=== Testing host.js — status ===');

    const tempDir = createTempDir();
    const hostPath = path.join(__dirname, 'host.js');

    const child = spawn(process.execPath, [hostPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const message = protocol.encodeMessage({ action: 'status', repo_path: tempDir });
    child.stdin.write(message);
    child.stdin.end();

    let stdout = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
    });

    child.on('exit', (code) => {
      assert(code === 0, 'host.js exits with code 0 for status');

      if (stdout.length >= 4) {
        try {
          const response = protocol.decodeMessage(stdout);
          assert(response.success === true, 'Status response success');
          assert(response.daemon !== undefined, 'Status response has daemon info');
          assert(response.queue !== undefined, 'Status response has queue info');
          assert(typeof response.queue.pending === 'number', 'Status has pending count');
        } catch (err) {
          assert(false, `Status response parsing failed: ${err.message}`);
        }
      } else {
        assert(false, 'No response received');
      }

      cleanupDir(tempDir);
      resolve();
    });
  });
}

// ============================================================
// Run all tests
// ============================================================

async function runAll() {
  console.log('Bug Bridge Native Host — Automated Tests');
  console.log('=========================================');

  testProtocol();
  testQueue();
  testFileWriter();
  testPromptGenerator();
  testDaemonClient();
  await testHostPing();
  await testHostBugReport();
  await testHostStatus();

  console.log('\n=========================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f}`));
  }

  process.exit(failed > 0 ? 1 : 0);
}

runAll();
