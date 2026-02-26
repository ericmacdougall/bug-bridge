/**
 * Terminal utilities for opening tmux sessions.
 * @module terminal
 */

'use strict';

const { execSync } = require('child_process');
const daemonClient = require('./daemon-client');

/**
 * Gets instructions for the user to attach to the tmux session.
 * @param {string} repoPath - Absolute path to the repo
 * @returns {{ command: string, sessionName: string, running: boolean }}
 */
function getAttachInfo(repoPath) {
  const sessionName = daemonClient.getTmuxSessionName(repoPath);
  const command = daemonClient.getTmuxAttachCommand(repoPath);
  const status = daemonClient.getDaemonStatus(repoPath);

  return {
    command,
    sessionName,
    running: status.running
  };
}

module.exports = { getAttachInfo };
