/**
 * Bridge between the short-lived host.js and the long-running daemon.js.
 * Ensures exactly one daemon is running per repo inside a tmux session.
 * @module daemon-client
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const queue = require('./queue');

/**
 * Gets the PID file path for a repo's daemon.
 * @param {string} repoPath - Absolute path to the repo
 * @returns {string} Path to .daemon.pid
 */
function getPidPath(repoPath) {
  return path.join(repoPath, '.bug-reports', '.daemon.pid');
}

/**
 * Generates a tmux session name from a repo path.
 * @param {string} repoPath - Absolute path to the repo
 * @returns {string} tmux session name like "bug-bridge-my-app"
 */
function getTmuxSessionName(repoPath) {
  const basename = path.basename(repoPath);
  return `bug-bridge-${basename}`;
}

/**
 * Checks if a process with the given PID is alive.
 * @param {number} pid - Process ID to check
 * @returns {boolean} True if process is alive
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Checks if tmux is installed.
 * @returns {boolean} True if tmux is available
 */
function isTmuxInstalled() {
  try {
    execFileSync('which', ['tmux'], { stdio: 'pipe' });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Checks if a tmux session exists.
 * @param {string} sessionName - tmux session name
 * @returns {boolean} True if session exists
 */
function tmuxSessionExists(sessionName) {
  try {
    execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'pipe' });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Kills a tmux session.
 * @param {string} sessionName - tmux session name to kill
 */
function killTmuxSession(sessionName) {
  try {
    execFileSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'pipe' });
  } catch (err) {
    // Ignore — session may not exist
  }
}

/**
 * Ensures a daemon is running for the given repo. Starts one if needed.
 * @param {string} repoPath - Absolute path to the repo
 * @param {string} daemonScriptPath - Absolute path to daemon.js
 * @returns {{ success: boolean, started: boolean, pid: number|null, tmuxSession: string, error?: string }}
 */
function ensureDaemon(repoPath, daemonScriptPath) {
  if (!isTmuxInstalled()) {
    return {
      success: false,
      started: false,
      pid: null,
      tmuxSession: null,
      error: 'tmux is not installed. Install it with: brew install tmux (macOS) or sudo apt install tmux (Linux)'
    };
  }

  const pidPath = getPidPath(repoPath);
  const sessionName = getTmuxSessionName(repoPath);

  // Check if daemon is already running
  if (fs.existsSync(pidPath)) {
    try {
      const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
      if (pid && isProcessAlive(pid)) {
        return {
          success: true,
          started: false,
          pid,
          tmuxSession: sessionName
        };
      }
    } catch (err) {
      // Stale or corrupt PID file — continue to start new daemon
    }
    // Clean up stale PID file
    try {
      fs.unlinkSync(pidPath);
    } catch (err) {
      // Ignore
    }
  }

  // Kill stale tmux session if it exists
  if (tmuxSessionExists(sessionName)) {
    killTmuxSession(sessionName);
  }

  // Ensure .bug-reports directory exists
  const bugReportsDir = path.join(repoPath, '.bug-reports');
  if (!fs.existsSync(bugReportsDir)) {
    fs.mkdirSync(bugReportsDir, { recursive: true });
  }

  // Start new daemon inside tmux
  try {
    const nodePath = process.execPath;
    execFileSync('tmux', [
      'new-session', '-d', '-s', sessionName,
      nodePath, daemonScriptPath, repoPath
    ], { stdio: 'pipe' });

    // Give the daemon a moment to start and write its PID
    // The daemon writes its own PID file on startup
    let pid = null;
    const maxWait = 3000;
    const interval = 100;
    let elapsed = 0;

    while (elapsed < maxWait) {
      if (fs.existsSync(pidPath)) {
        try {
          pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
          if (pid && isProcessAlive(pid)) {
            break;
          }
        } catch (err) {
          // PID file being written, retry
        }
      }
      const start = Date.now();
      while (Date.now() - start < interval) {
        // Spin wait
      }
      elapsed += interval;
    }

    // If we couldn't read the PID, try to get it from tmux
    if (!pid) {
      try {
        const tmuxPid = execFileSync('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_pid}'], { stdio: 'pipe' }).toString().trim();
        pid = parseInt(tmuxPid, 10) || null;
        if (pid) {
          fs.writeFileSync(pidPath, String(pid), 'utf8');
        }
      } catch (err) {
        // Couldn't get PID from tmux
      }
    }

    return {
      success: true,
      started: true,
      pid,
      tmuxSession: sessionName
    };
  } catch (err) {
    return {
      success: false,
      started: false,
      pid: null,
      tmuxSession: sessionName,
      error: `Failed to start daemon: ${err.message}`
    };
  }
}

/**
 * Gets the current status of the daemon for a repo.
 * @param {string} repoPath - Absolute path to the repo
 * @returns {{ running: boolean, pid: number|null, tmuxSession: string|null, queueLength: number, activeReport: object|null }}
 */
function getDaemonStatus(repoPath) {
  const pidPath = getPidPath(repoPath);
  const sessionName = getTmuxSessionName(repoPath);

  let running = false;
  let pid = null;

  if (fs.existsSync(pidPath)) {
    try {
      pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
      if (pid && isProcessAlive(pid)) {
        running = true;
      } else {
        pid = null;
      }
    } catch (err) {
      pid = null;
    }
  }

  let queueLength = 0;
  let activeReport = null;
  try {
    const pending = queue.getPending(repoPath);
    queueLength = pending.length;
    activeReport = queue.getActive(repoPath);
  } catch (err) {
    // Queue doesn't exist yet
  }

  return {
    running,
    pid,
    tmuxSession: running ? sessionName : null,
    queueLength,
    activeReport
  };
}

/**
 * Returns the tmux attach command string for a repo's daemon session.
 * @param {string} repoPath - Absolute path to the repo
 * @returns {string} The tmux attach command
 */
function getTmuxAttachCommand(repoPath) {
  const sessionName = getTmuxSessionName(repoPath);
  return `tmux attach -t ${sessionName}`;
}

module.exports = {
  ensureDaemon,
  getDaemonStatus,
  getTmuxAttachCommand,
  getTmuxSessionName,
  isTmuxInstalled,
  isProcessAlive,
  getPidPath
};
