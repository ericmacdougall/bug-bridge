#!/usr/bin/env node

/**
 * Native messaging host for Bug Bridge.
 *
 * Short-lived process: Chrome spawns it for each message.
 * Reads a message from stdin, processes it, writes a response to stdout, and exits.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const protocol = require('./lib/protocol');
const fileWriter = require('./lib/file-writer');
const promptGenerator = require('./lib/prompt-generator');
const queue = require('./lib/queue');
const daemonClient = require('./lib/daemon-client');

/**
 * Sends a response and exits.
 * @param {object} response - The response object to send
 * @param {number} [exitCode=0] - Process exit code
 */
function respond(response, exitCode = 0) {
  protocol.writeMessage(process.stdout, response);
  process.exit(exitCode);
}

/**
 * Handles a ping message.
 */
function handlePing() {
  respond({ success: true, version: '0.1.0' });
}

/**
 * Handles a status request message.
 * @param {object} message - The status request with repo_path
 */
function handleStatus(message) {
  const repoPath = message.repo_path;

  if (!repoPath) {
    respond({ success: false, error: 'No repo_path in status request' });
    return;
  }

  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    respond({ success: false, error: `Repo path does not exist: ${repoPath}` });
    return;
  }

  const status = daemonClient.getDaemonStatus(repoPath);
  const tmuxSession = daemonClient.getTmuxSessionName(repoPath);
  const tmuxAttachCommand = daemonClient.getTmuxAttachCommand(repoPath);

  // Get queue stats
  let pending = 0;
  let processing = null;
  let completedToday = 0;
  let failedToday = 0;

  try {
    const q = queue.getQueue(repoPath);
    const today = new Date().toISOString().slice(0, 10);

    for (const report of q.reports) {
      if (report.status === 'pending') pending++;
      if (report.status === 'processing') {
        processing = {
          id: report.id,
          description_preview: report.description_preview
        };
      }
      if (report.status === 'complete' && report.completed_at && report.completed_at.startsWith(today)) {
        completedToday++;
      }
      if (report.status === 'failed' && report.completed_at && report.completed_at.startsWith(today)) {
        failedToday++;
      }
    }
  } catch (err) {
    // Queue doesn't exist yet — all zeros
  }

  respond({
    success: true,
    daemon: {
      running: status.running,
      tmux_session: tmuxSession,
      tmux_attach_command: tmuxAttachCommand
    },
    queue: {
      pending,
      processing,
      completed_today: completedToday,
      failed_today: failedToday
    }
  });
}

/**
 * Handles a bug report bundle message.
 * @param {object} bundle - The bug report bundle
 */
function handleBugReport(bundle) {
  const repoPath = bundle.repo_path;

  // Validate repo_path
  if (!repoPath) {
    respond({ success: false, error: 'No repo_path in message. Update Bug Bridge extension.' });
    return;
  }

  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    respond({ success: false, error: `Repo path does not exist: ${repoPath}` });
    return;
  }

  // Step 1: Write files
  let writeResult;
  try {
    writeResult = fileWriter.writeBundle(bundle);
  } catch (err) {
    respond({ success: false, error: `Failed to write files: ${err.message}` });
    return;
  }

  // Step 2: Generate prompt.md
  try {
    promptGenerator.writePrompt(bundle, writeResult.dir, repoPath);
  } catch (err) {
    respond({ success: false, error: `Failed to generate prompt: ${err.message}` });
    return;
  }

  // Step 3: Enqueue the report
  let queueEntry;
  try {
    queueEntry = queue.enqueue(repoPath, {
      id: writeResult.id,
      dir: writeResult.dir,
      description_preview: (bundle.description || '').substring(0, 100),
      url: (bundle.meta && bundle.meta.url) || 'unknown'
    });
  } catch (err) {
    respond({ success: false, error: `Failed to enqueue report: ${err.message}` });
    return;
  }

  // Step 4: Ensure daemon is running
  const daemonScriptPath = path.join(__dirname, 'daemon.js');
  let daemonResult;
  try {
    daemonResult = daemonClient.ensureDaemon(repoPath, daemonScriptPath);
  } catch (err) {
    // Daemon failure is non-fatal — files are still written and queued
    daemonResult = { success: false, started: false, pid: null, tmuxSession: null, error: err.message };
  }

  // Calculate queue position
  let queuePosition = 1;
  try {
    const pendingReports = queue.getPending(repoPath);
    const activeReport = queue.getActive(repoPath);
    if (activeReport) {
      queuePosition = pendingReports.length + 1;
    } else {
      queuePosition = pendingReports.length;
    }
  } catch (err) {
    // Default to 1
  }

  const tmuxSession = daemonClient.getTmuxSessionName(repoPath);
  const tmuxAttachCommand = daemonClient.getTmuxAttachCommand(repoPath);

  // Step 5: Respond
  respond({
    success: true,
    report_dir: writeResult.dir,
    files_written: writeResult.filesWritten,
    queue_position: queuePosition,
    daemon: {
      running: daemonResult.success !== false,
      started: daemonResult.started || false,
      tmux_session: tmuxSession,
      tmux_attach_command: tmuxAttachCommand
    },
    errors: writeResult.errors.length > 0 ? writeResult.errors : undefined
  });
}

/**
 * Main entry point.
 */
async function main() {
  try {
    const message = await protocol.readMessage(process.stdin);

    // Route based on message type
    if (message.action === 'ping') {
      handlePing();
    } else if (message.action === 'status') {
      handleStatus(message);
    } else if (message.version === '1') {
      handleBugReport(message);
    } else {
      respond({ success: false, error: 'Unknown message format' });
    }
  } catch (err) {
    respond({ success: false, error: `Invalid message format: ${err.message}` }, 1);
  }
}

main();
