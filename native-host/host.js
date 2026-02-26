#!/usr/bin/env node

/**
 * Native messaging host for Bug Bridge.
 *
 * Short-lived process: Chrome spawns it for each message.
 * Reads a message from stdin, processes it, writes a response to stdout, and exits.
 *
 * Also supports persistent connections (connectNative) for chunked streaming
 * of large bundles that exceed Chrome's 1MB per-message limit.
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
 * Sends a response without exiting (for persistent connections).
 * @param {object} response - The response object to send
 */
function sendResponse(response) {
  protocol.writeMessage(process.stdout, response);
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
 * @param {boolean} [persistent=false] - If true, don't exit after responding
 */
function handleBugReport(bundle, persistent = false) {
  const repoPath = bundle.repo_path;
  const respondFn = persistent ? sendResponse : respond;

  // Validate repo_path
  if (!repoPath) {
    respondFn({ success: false, error: 'No repo_path in message. Update Bug Bridge extension.' });
    if (persistent) process.exit(0);
    return;
  }

  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    respondFn({ success: false, error: `Repo path does not exist: ${repoPath}` });
    if (persistent) process.exit(0);
    return;
  }

  // Step 1: Write files
  let writeResult;
  try {
    writeResult = fileWriter.writeBundle(bundle);
  } catch (err) {
    respondFn({ success: false, error: `Failed to write files: ${err.message}` });
    if (persistent) process.exit(0);
    return;
  }

  // Step 2: Generate prompt.md
  try {
    promptGenerator.writePrompt(bundle, writeResult.dir, repoPath);
  } catch (err) {
    respondFn({ success: false, error: `Failed to generate prompt: ${err.message}` });
    if (persistent) process.exit(0);
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
    respondFn({ success: false, error: `Failed to enqueue report: ${err.message}` });
    if (persistent) process.exit(0);
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
  respondFn({
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

  if (persistent) process.exit(0);
}

/**
 * Handles a chunked/persistent connection.
 * Reads multiple messages from stdin, reassembles the bundle, then processes it.
 *
 * Protocol:
 * 1. First message: metadata (bundle without large fields, has _chunked: true)
 * 2. Subsequent messages: { _chunk: true, field, index, total, data }
 * 3. Final message: { _chunk_complete: true }
 */
async function handleChunkedConnection() {
  let bundle = null;
  const chunks = {};

  while (true) {
    let message;
    try {
      message = await protocol.readMessage(process.stdin);
    } catch (err) {
      // Stream ended or error — if we have a bundle, process it
      if (bundle) {
        reassembleAndProcess(bundle, chunks);
      } else {
        respond({ success: false, error: `Chunked read error: ${err.message}` }, 1);
      }
      return;
    }

    if (message._chunked) {
      // First message: the metadata/skeleton bundle
      bundle = message;
      delete bundle._chunked;
    } else if (message._chunk) {
      // A chunk of a large field
      const { field, index, total, data } = message;
      if (!chunks[field]) {
        chunks[field] = { total, parts: [] };
      }
      chunks[field].parts[index] = data;
    } else if (message._chunk_complete) {
      // All chunks received — reassemble and process
      if (bundle) {
        reassembleAndProcess(bundle, chunks);
      } else {
        sendResponse({ success: false, error: 'Received chunk_complete without initial message' });
        process.exit(1);
      }
      return;
    } else {
      // Not a chunked message — treat as a regular single message
      if (message.action === 'ping') {
        sendResponse({ success: true, version: '0.1.0' });
        process.exit(0);
      } else if (message.action === 'status') {
        handleStatus(message);
      } else if (message.version === '1') {
        handleBugReport(message, true);
      } else {
        sendResponse({ success: false, error: 'Unknown message format' });
        process.exit(0);
      }
      return;
    }
  }
}

/**
 * Reassembles chunked fields into the bundle and processes it.
 * @param {object} bundle - The skeleton bundle
 * @param {object} chunks - Map of field name to { total, parts[] }
 */
function reassembleAndProcess(bundle, chunks) {
  for (const [field, chunkData] of Object.entries(chunks)) {
    // Validate all chunks were received (no sparse/missing entries)
    const received = chunkData.parts.filter(p => p !== undefined).length;
    if (received !== chunkData.total) {
      process.stderr.write(`Warning: field "${field}" missing ${chunkData.total - received}/${chunkData.total} chunks\n`);
      bundle[field] = null;
      continue;
    }

    const reassembled = chunkData.parts.join('');

    // Determine if this field should be a string or parsed JSON
    if (field === 'network_har') {
      try {
        bundle[field] = JSON.parse(reassembled);
      } catch (err) {
        bundle[field] = null;
      }
    } else {
      bundle[field] = reassembled;
    }
  }

  // Clean up marker fields
  for (const key of Object.keys(bundle)) {
    if (key.startsWith('_has_')) {
      delete bundle[key];
    }
  }

  handleBugReport(bundle, true);
}

/**
 * Main entry point.
 * Detects whether this is a single-message or persistent connection.
 */
async function main() {
  try {
    const message = await protocol.readMessage(process.stdin);

    // Check if this is the start of a chunked connection
    if (message._chunked) {
      // Re-process this first message and continue reading chunks
      const bundle = message;
      delete bundle._chunked;
      const chunks = {};

      while (true) {
        let nextMessage;
        try {
          nextMessage = await protocol.readMessage(process.stdin);
        } catch (err) {
          reassembleAndProcess(bundle, chunks);
          return;
        }

        if (nextMessage._chunk) {
          const { field, index, total, data } = nextMessage;
          if (!chunks[field]) {
            chunks[field] = { total, parts: [] };
          }
          chunks[field].parts[index] = data;
        } else if (nextMessage._chunk_complete) {
          reassembleAndProcess(bundle, chunks);
          return;
        }
      }
    }

    // Route based on message type (single-message mode)
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
