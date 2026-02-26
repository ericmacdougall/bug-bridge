/**
 * File-based bug report queue management.
 *
 * Each repo has its own queue at `{repoPath}/.bug-reports/queue.json`.
 * Uses simple file-based locking to prevent corruption from concurrent writes.
 * @module queue
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Synchronous sleep that doesn't burn CPU.
 * @param {number} ms - Milliseconds to sleep
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Gets the path to the queue file for a repo.
 * @param {string} repoPath - Absolute path to the repo
 * @returns {string} Path to queue.json
 */
function getQueuePath(repoPath) {
  return path.join(repoPath, '.bug-reports', 'queue.json');
}

/**
 * Gets the path to the lock file for a repo's queue.
 * @param {string} repoPath - Absolute path to the repo
 * @returns {string} Path to queue.lock
 */
function getLockPath(repoPath) {
  return path.join(repoPath, '.bug-reports', 'queue.lock');
}

/**
 * Acquires a file lock for the queue. Spins up to 2 seconds.
 * @param {string} repoPath - Absolute path to the repo
 * @returns {boolean} True if lock was acquired
 */
function acquireLock(repoPath) {
  const lockPath = getLockPath(repoPath);
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const maxWait = 2000;
  const interval = 50;
  let elapsed = 0;

  while (elapsed < maxWait) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Check if lock is stale (older than 10 seconds)
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 10000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch (e) {
          // Lock file was removed by another process
          continue;
        }
        const waitTime = Math.min(interval, maxWait - elapsed);
        sleepSync(waitTime);
        elapsed += waitTime;
      } else {
        throw err;
      }
    }
  }

  return false;
}

/**
 * Releases the file lock for the queue.
 * @param {string} repoPath - Absolute path to the repo
 */
function releaseLock(repoPath) {
  const lockPath = getLockPath(repoPath);
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    // Ignore if already removed
  }
}

/**
 * Reads the queue file, creating it if it doesn't exist.
 * @param {string} repoPath - Absolute path to the repo
 * @returns {object} The queue object with a `reports` array
 */
function readQueue(repoPath) {
  const queuePath = getQueuePath(repoPath);
  try {
    const data = fs.readFileSync(queuePath, 'utf8');
    const parsed = JSON.parse(data);
    // Validate structure
    if (!parsed || !Array.isArray(parsed.reports)) {
      return { reports: [] };
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { reports: [] };
    }
    if (err instanceof SyntaxError) {
      // Corrupted JSON — back up the corrupted file and start fresh
      const backupPath = queuePath + '.corrupted.' + Date.now();
      try {
        fs.copyFileSync(queuePath, backupPath);
        process.stderr.write(`Warning: queue.json was corrupted, backed up to ${backupPath}\n`);
      } catch (e) {
        // Ignore backup failures
      }
      return { reports: [] };
    }
    throw new Error(`Failed to read queue: ${err.message}`);
  }
}

/**
 * Writes the queue file.
 * @param {string} repoPath - Absolute path to the repo
 * @param {object} queue - The queue object to write
 */
function writeQueue(repoPath, queue) {
  const queuePath = getQueuePath(repoPath);
  const dir = path.dirname(queuePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
}

/**
 * Adds a report to the queue with status "pending".
 * @param {string} repoPath - Absolute path to the repo
 * @param {object} reportEntry - The report entry to enqueue
 * @param {string} reportEntry.id - Report ID (timestamp-based)
 * @param {string} reportEntry.dir - Absolute path to report directory
 * @param {string} reportEntry.description_preview - First 100 chars of description
 * @param {string} reportEntry.url - URL the bug was reported on
 * @returns {object} The enqueued report entry with status and timestamps
 */
function enqueue(repoPath, reportEntry) {
  if (!acquireLock(repoPath)) {
    throw new Error('Could not acquire queue lock after 2 seconds');
  }
  try {
    const queue = readQueue(repoPath);
    const entry = {
      id: reportEntry.id,
      status: 'pending',
      dir: reportEntry.dir,
      description_preview: reportEntry.description_preview,
      url: reportEntry.url,
      queued_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      error: null
    };
    queue.reports.push(entry);
    writeQueue(repoPath, queue);
    return entry;
  } finally {
    releaseLock(repoPath);
  }
}

/**
 * Returns the full queue object.
 * @param {string} repoPath - Absolute path to the repo
 * @returns {object} The queue object with `reports` array
 */
function getQueue(repoPath) {
  try {
    return readQueue(repoPath);
  } catch (err) {
    throw new Error(`Failed to get queue: ${err.message}`);
  }
}

/**
 * Returns the next pending report, or null if none.
 * @param {string} repoPath - Absolute path to the repo
 * @returns {object|null} The next pending report entry, or null
 */
function getNext(repoPath) {
  const queue = readQueue(repoPath);
  return queue.reports.find(r => r.status === 'pending') || null;
}

/**
 * Marks a report as "processing" and sets started_at.
 * @param {string} repoPath - Absolute path to the repo
 * @param {string} reportId - The report ID to mark
 */
function markProcessing(repoPath, reportId) {
  if (!acquireLock(repoPath)) {
    throw new Error('Could not acquire queue lock after 2 seconds');
  }
  try {
    const queue = readQueue(repoPath);
    const report = queue.reports.find(r => r.id === reportId);
    if (report) {
      report.status = 'processing';
      report.started_at = new Date().toISOString();
      writeQueue(repoPath, queue);
    }
  } finally {
    releaseLock(repoPath);
  }
}

/**
 * Marks a report as "complete" and sets completed_at.
 * @param {string} repoPath - Absolute path to the repo
 * @param {string} reportId - The report ID to mark
 */
function markComplete(repoPath, reportId) {
  if (!acquireLock(repoPath)) {
    throw new Error('Could not acquire queue lock after 2 seconds');
  }
  try {
    const queue = readQueue(repoPath);
    const report = queue.reports.find(r => r.id === reportId);
    if (report) {
      report.status = 'complete';
      report.completed_at = new Date().toISOString();
      writeQueue(repoPath, queue);
    }
  } finally {
    releaseLock(repoPath);
  }
}

/**
 * Marks a report as "failed" with an error message.
 * @param {string} repoPath - Absolute path to the repo
 * @param {string} reportId - The report ID to mark
 * @param {string} errorMessage - Description of the failure
 */
function markFailed(repoPath, reportId, errorMessage) {
  if (!acquireLock(repoPath)) {
    throw new Error('Could not acquire queue lock after 2 seconds');
  }
  try {
    const queue = readQueue(repoPath);
    const report = queue.reports.find(r => r.id === reportId);
    if (report) {
      report.status = 'failed';
      report.error = errorMessage;
      report.completed_at = new Date().toISOString();
      writeQueue(repoPath, queue);
    }
  } finally {
    releaseLock(repoPath);
  }
}

/**
 * Returns array of pending reports.
 * @param {string} repoPath - Absolute path to the repo
 * @returns {Array<object>} Array of pending report entries
 */
function getPending(repoPath) {
  const queue = readQueue(repoPath);
  return queue.reports.filter(r => r.status === 'pending');
}

/**
 * Returns the currently processing report, or null.
 * @param {string} repoPath - Absolute path to the repo
 * @returns {object|null} The active report entry, or null
 */
function getActive(repoPath) {
  const queue = readQueue(repoPath);
  return queue.reports.find(r => r.status === 'processing') || null;
}

module.exports = {
  enqueue,
  getQueue,
  getNext,
  markProcessing,
  markComplete,
  markFailed,
  getPending,
  getActive
};
