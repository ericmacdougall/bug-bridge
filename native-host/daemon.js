#!/usr/bin/env node

/**
 * Long-running daemon that processes bug reports from the queue.
 * Runs inside a tmux session and spawns Claude Code for each report.
 *
 * Usage: node daemon.js /path/to/repo
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const queue = require('./lib/queue');

const repoPath = process.argv[2];

if (!repoPath) {
  console.error('Usage: node daemon.js /path/to/repo');
  process.exit(1);
}

if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
  console.error(`Repo path does not exist or is not a directory: ${repoPath}`);
  process.exit(1);
}

// Write PID file
const pidPath = path.join(repoPath, '.bug-reports', '.daemon.pid');
const bugReportsDir = path.join(repoPath, '.bug-reports');
if (!fs.existsSync(bugReportsDir)) {
  fs.mkdirSync(bugReportsDir, { recursive: true });
}
fs.writeFileSync(pidPath, String(process.pid), 'utf8');

// Cleanup on exit
process.on('exit', () => {
  try {
    if (fs.existsSync(pidPath)) {
      const storedPid = fs.readFileSync(pidPath, 'utf8').trim();
      if (storedPid === String(process.pid)) {
        fs.unlinkSync(pidPath);
      }
    }
  } catch (err) {
    // Ignore
  }
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

let paused = false;

/**
 * Prints a separator banner between reports.
 * @param {string} completedDesc - Description of the completed report
 * @param {object|null} nextReport - The next report to process, if any
 */
function printSeparator(completedDesc, nextReport) {
  console.log('');
  console.log('\u2550'.repeat(59));
  console.log(`\u2713 Completed: "${completedDesc}"`);
  console.log('\u2550'.repeat(59));

  if (nextReport) {
    console.log('');
    console.log(`\uD83D\uDCCB Next in queue: "${nextReport.description_preview}"`);
    console.log(`   URL: ${nextReport.url}`);
    const relDir = path.relative(repoPath, nextReport.dir);
    console.log(`   Report: ${relDir}/`);
    console.log('');
  }
}

/**
 * Runs Claude Code on a bug report.
 * @param {object} report - The report entry from the queue
 * @returns {Promise<number>} Exit code from Claude Code
 */
function runClaudeCode(report) {
  return new Promise((resolve) => {
    const promptPath = path.join(report.dir, 'prompt.md');
    const prompt = `Read the bug report at ${promptPath} and follow its instructions to diagnose and fix the bug. All context files are in that same directory.`;

    console.log(`\uD83D\uDD27 Running Claude Code for: "${report.description_preview}"`);
    console.log(`   Report dir: ${path.relative(repoPath, report.dir)}/`);
    console.log('');

    const child = spawn('claude', ['-p', prompt], {
      cwd: repoPath,
      stdio: 'inherit',
      shell: true
    });

    child.on('error', (err) => {
      console.error(`Failed to start Claude Code: ${err.message}`);
      resolve(1);
    });

    child.on('exit', (code) => {
      resolve(code || 0);
    });
  });
}

/**
 * Waits for a countdown with skip/pause controls.
 * @param {number} seconds - Number of seconds to wait
 * @returns {Promise<'continue'|'skip'|'pause'>} User action
 */
function countdown(seconds) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    let remaining = seconds;
    let resolved = false;

    const onData = (data) => {
      const key = data.toString();
      if (key === '\x03') {
        // Ctrl+C — skip
        cleanup();
        resolve('skip');
      } else if (key === 'q' || key === 'Q') {
        cleanup();
        resolve('pause');
      }
    };

    process.stdin.on('data', onData);

    const timer = setInterval(() => {
      if (resolved) return;
      remaining--;
      process.stdout.write(`\rStarting in ${remaining} seconds... (Ctrl+C to skip, press 'q' to pause queue) `);
      if (remaining <= 0) {
        cleanup();
        resolve('continue');
      }
    }, 1000);

    process.stdout.write(`Starting in ${remaining} seconds... (Ctrl+C to skip, press 'q' to pause queue) `);

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      clearInterval(timer);
      process.stdin.removeListener('data', onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      console.log('');
    };
  });
}

/**
 * Main daemon loop.
 */
async function main() {
  console.log('\u2550'.repeat(59));
  console.log(' Bug Bridge Daemon');
  console.log(` Repo: ${repoPath}`);
  console.log(` PID: ${process.pid}`);
  console.log('\u2550'.repeat(59));
  console.log('');

  let lastCompletedDesc = null;

  while (true) {
    if (paused) {
      process.stdout.write("\r\u23F8  Queue paused — press 'r' to resume... ");
      await new Promise((resolve) => {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
        }
        process.stdin.resume();
        const onData = (data) => {
          const key = data.toString();
          if (key === 'r' || key === 'R') {
            process.stdin.removeListener('data', onData);
            if (process.stdin.isTTY) {
              process.stdin.setRawMode(false);
            }
            process.stdin.pause();
            paused = false;
            console.log('\n\u25B6  Queue resumed');
            resolve();
          }
        };
        process.stdin.on('data', onData);
      });
      continue;
    }

    const nextReport = queue.getNext(repoPath);

    if (!nextReport) {
      process.stdout.write(`\r\u23F3 Queue empty \u2014 waiting for new bug reports...   `);
      process.stdout.write(`\n   Watching: ${path.join(repoPath, '.bug-reports', 'queue.json')}\r`);
      await sleep(2000);
      // Move cursor up to overwrite
      process.stdout.write('\x1B[1A');
      continue;
    }

    // If we just completed a report and there's a next one, show separator + countdown
    if (lastCompletedDesc !== null) {
      printSeparator(lastCompletedDesc, nextReport);

      const action = await countdown(5);
      if (action === 'skip') {
        console.log('Skipping next report...');
        queue.markFailed(repoPath, nextReport.id, 'Skipped by user');
        lastCompletedDesc = `SKIPPED: ${nextReport.description_preview}`;
        continue;
      } else if (action === 'pause') {
        paused = true;
        continue;
      }
    }

    // Process the report
    queue.markProcessing(repoPath, nextReport.id);

    console.log('\u2550'.repeat(59));
    const exitCode = await runClaudeCode(nextReport);

    if (exitCode === 0) {
      queue.markComplete(repoPath, nextReport.id);
      lastCompletedDesc = nextReport.description_preview;
    } else {
      queue.markFailed(repoPath, nextReport.id, `Claude Code exited with code ${exitCode}`);
      lastCompletedDesc = `FAILED: ${nextReport.description_preview}`;
    }
  }
}

/**
 * Sleep utility.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(`Daemon error: ${err.message}`);
  process.exit(1);
});
