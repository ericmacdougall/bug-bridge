#!/usr/bin/env node

/**
 * Manual test for the daemon process.
 *
 * Creates a test repo with a mock queue entry, starts the daemon,
 * and prints instructions for manual verification.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const queue = require('./lib/queue');
const fileWriter = require('./lib/file-writer');
const promptGenerator = require('./lib/prompt-generator');
const daemonClient = require('./lib/daemon-client');

const testRepoPath = path.join('/tmp', 'bug-bridge-daemon-test');

// Clean up previous test
if (fs.existsSync(testRepoPath)) {
  fs.rmSync(testRepoPath, { recursive: true, force: true });
}
fs.mkdirSync(testRepoPath, { recursive: true });

// Create a minimal mock bundle
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const bundle = {
  version: '1',
  repo_path: testRepoPath,
  screenshot_raw: `data:image/png;base64,${pngBase64}`,
  screenshot_annotated: null,
  description: 'Test bug report: The submit button does not respond when clicked. Expected the form to submit and show a success message.',
  console_errors: [
    {
      level: 'error',
      message: 'TypeError: Cannot read properties of undefined (reading "submit")',
      stack: 'at handleSubmit (app.js:42)',
      timestamp: new Date().toISOString(),
      source: 'app.js',
      line: 42,
      column: 12
    }
  ],
  network_har: {
    log: {
      version: '1.2',
      creator: { name: 'Bug Bridge', version: '0.1.0' },
      entries: []
    }
  },
  network_errors_only: [],
  cookies: [],
  page_source: '<!DOCTYPE html><html><body><h1>Test</h1></body></html>',
  meta: {
    url: 'http://localhost:3000/test',
    title: 'Test Page',
    timestamp: new Date().toISOString(),
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 Test',
    screenResolution: { width: 2560, height: 1440 },
    devicePixelRatio: 2
  }
};

console.log('Bug Bridge Daemon — Manual Test');
console.log('================================');
console.log(`Test repo: ${testRepoPath}`);
console.log('');

// Write bundle files
console.log('1. Writing mock bug report files...');
const writeResult = fileWriter.writeBundle(bundle);
console.log(`   Report dir: ${writeResult.dir}`);
console.log(`   Files written: ${writeResult.filesWritten}`);

// Generate prompt
console.log('2. Generating prompt.md...');
promptGenerator.writePrompt(bundle, writeResult.dir, testRepoPath);
console.log('   Done');

// Enqueue
console.log('3. Enqueuing report...');
queue.enqueue(testRepoPath, {
  id: writeResult.id,
  dir: writeResult.dir,
  description_preview: bundle.description.substring(0, 100),
  url: bundle.meta.url
});
console.log('   Done');

// Check if tmux is installed
if (!daemonClient.isTmuxInstalled()) {
  console.log('');
  console.log('ERROR: tmux is not installed.');
  console.log('Install with: brew install tmux (macOS) or sudo apt install tmux (Linux)');
  process.exit(1);
}

// Start daemon
console.log('4. Starting daemon...');
const daemonScriptPath = path.join(__dirname, 'daemon.js');
const result = daemonClient.ensureDaemon(testRepoPath, daemonScriptPath);

if (result.success) {
  console.log(`   Daemon ${result.started ? 'started' : 'already running'}`);
  console.log(`   PID: ${result.pid}`);
  console.log(`   tmux session: ${result.tmuxSession}`);
  console.log('');
  console.log('================================');
  console.log('Manual verification steps:');
  console.log('');
  console.log(`   1. Attach to tmux session:`);
  console.log(`      ${daemonClient.getTmuxAttachCommand(testRepoPath)}`);
  console.log('');
  console.log('   2. You should see the daemon pick up the queued report');
  console.log('      and attempt to run Claude Code');
  console.log('');
  console.log('   3. Claude Code may fail (fake report) — that\'s expected.');
  console.log('      The point is the daemon tried to run it.');
  console.log('');
  console.log('   4. To exit tmux: press Ctrl+B, then D');
  console.log('');
  console.log(`   5. To clean up: tmux kill-session -t ${result.tmuxSession}`);
  console.log(`      rm -rf ${testRepoPath}`);
} else {
  console.log(`   Failed: ${result.error}`);
  process.exit(1);
}
