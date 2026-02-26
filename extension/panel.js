/**
 * DevTools panel script for Bug Bridge.
 * Captures network requests via chrome.devtools.network and displays live stats.
 */

'use strict';

// HAR collector (inline since we can't import ES modules in panel context)
const entries = [];
const MAX_ENTRIES = 1000;

const requestCountEl = document.getElementById('request-count');
const errorCountEl = document.getElementById('error-count');
const networkErrorsList = document.getElementById('network-errors-list');
const consoleErrorsList = document.getElementById('console-errors-list');
const panelQueueSection = document.getElementById('panel-queue-section');
const panelQueueStatus = document.getElementById('panel-queue-status');
const panelTerminalBtn = document.getElementById('panel-terminal-btn');
const panelReportBtn = document.getElementById('panel-report-btn');
const panelClearBtn = document.getElementById('panel-clear-btn');
const panelToast = document.getElementById('panel-toast');

let tmuxCmd = '';
const tabId = chrome.devtools.inspectedWindow.tabId;

/** @type {Array<object>} Console errors from content script */
let consoleErrors = [];

// ============================================================
// Network capture
// ============================================================

chrome.devtools.network.onRequestFinished.addListener((request) => {
  // Build a HAR entry from the request
  const entry = {
    startedDateTime: request.startedDateTime || new Date().toISOString(),
    time: request.time || 0,
    request: {
      method: request.request.method,
      url: request.request.url,
      httpVersion: request.request.httpVersion || '',
      headers: request.request.headers || [],
      queryString: request.request.queryString || [],
      cookies: request.request.cookies || [],
      headersSize: request.request.headersSize || -1,
      bodySize: request.request.bodySize || -1
    },
    response: {
      status: request.response.status,
      statusText: request.response.statusText,
      httpVersion: request.response.httpVersion || '',
      headers: request.response.headers || [],
      cookies: request.response.cookies || [],
      content: {
        size: request.response.content ? request.response.content.size : 0,
        mimeType: request.response.content ? request.response.content.mimeType : '',
        compression: request.response.content ? request.response.content.compression : 0
      },
      redirectURL: request.response.redirectURL || '',
      headersSize: request.response.headersSize || -1,
      bodySize: request.response.bodySize || -1
    },
    cache: {},
    timings: request.timings || { send: 0, wait: 0, receive: 0 }
  };

  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.shift();
  }

  updateStats();
  storeHarInBackground();
});

/**
 * Updates the stats display and error lists.
 */
function updateStats() {
  const errorEntries = entries.filter(e => {
    const status = e.response ? e.response.status : 0;
    return status === 0 || status >= 400;
  });

  requestCountEl.textContent = entries.length;
  errorCountEl.textContent = errorEntries.length;

  // Update network errors list
  if (errorEntries.length > 0) {
    networkErrorsList.innerHTML = '';
    // Show most recent first, up to 50
    const recent = errorEntries.slice(-50).reverse();
    recent.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'list-item';

      const method = document.createElement('span');
      method.className = 'method';
      method.textContent = entry.request.method;

      const url = document.createElement('span');
      url.className = 'url';
      url.textContent = entry.request.url;
      url.title = entry.request.url;

      const status = document.createElement('span');
      status.className = 'status';
      status.textContent = entry.response.status || 'ERR';

      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = entry.time ? `${Math.round(entry.time)}ms` : '';

      item.appendChild(method);
      item.appendChild(url);
      item.appendChild(status);
      item.appendChild(time);
      networkErrorsList.appendChild(item);
    });
  }
}

/**
 * Stores HAR data in the background script for retrieval during capture.
 */
function storeHarInBackground() {
  const har = {
    log: {
      version: '1.2',
      creator: { name: 'Bug Bridge', version: '0.1.0' },
      entries: [...entries]
    }
  };

  const errorsOnly = entries.filter(e => {
    const status = e.response ? e.response.status : 0;
    return status === 0 || status >= 400;
  });

  chrome.runtime.sendMessage({
    action: 'storeHar',
    tabId,
    har,
    errorsOnly
  });
}

// ============================================================
// Console errors (poll from content script periodically)
// ============================================================

function fetchConsoleErrors() {
  try {
    chrome.devtools.inspectedWindow.eval(
      `(function() {
        return new Promise(function(resolve) {
          chrome.runtime.sendMessage({ action: 'getConsoleErrors' }, function(response) {
            resolve(response && response.errors ? response.errors : []);
          });
        });
      })()`,
      { useContentScriptContext: true },
      (result, error) => {
        // This approach may not work — fall back to direct tab message
      }
    );
  } catch (e) {
    // Ignore
  }

  // More reliable: ask background to relay
  chrome.runtime.sendMessage({ action: 'getConsoleErrorsForTab', tabId }, (response) => {
    if (response && response.errors) {
      consoleErrors = response.errors;
      updateConsoleErrorsList();
    }
  });
}

function updateConsoleErrorsList() {
  if (consoleErrors.length === 0) return;

  consoleErrorsList.innerHTML = '';
  const recent = consoleErrors.slice(-30).reverse();

  recent.forEach((err) => {
    const item = document.createElement('div');
    item.className = 'list-item';

    const icon = document.createElement('span');
    icon.className = 'level-icon';
    if (err.level === 'error' || err.level === 'unhandled_exception' || err.level === 'unhandled_rejection') {
      icon.textContent = '\u26D4';
    } else {
      icon.textContent = '\u26A0\uFE0F';
    }

    const msg = document.createElement('span');
    msg.className = 'message';
    msg.textContent = err.message;
    msg.title = err.message;

    const ts = document.createElement('span');
    ts.className = 'timestamp';
    try {
      ts.textContent = new Date(err.timestamp).toLocaleTimeString();
    } catch (e) {
      ts.textContent = '';
    }

    item.appendChild(icon);
    item.appendChild(msg);
    item.appendChild(ts);
    consoleErrorsList.appendChild(item);
  });
}

// Poll console errors every 3 seconds
setInterval(fetchConsoleErrors, 3000);

// ============================================================
// Queue / daemon status
// ============================================================

function checkPanelQueueStatus() {
  // We need the repo path — get it from storage
  chrome.runtime.sendMessage({ action: 'getCurrentTabMapping', tabId }, (response) => {
    if (!response || !response.mapping) {
      panelQueueSection.classList.remove('visible');
      return;
    }

    chrome.runtime.sendMessage({ action: 'nativeStatus', repoPath: response.mapping.repoPath }, (statusResp) => {
      if (!statusResp || !statusResp.success || !statusResp.daemon || !statusResp.daemon.running) {
        panelQueueSection.classList.remove('visible');
        return;
      }

      panelQueueSection.classList.add('visible');

      if (statusResp.queue && statusResp.queue.processing) {
        panelQueueStatus.textContent = `Working on: "${statusResp.queue.processing.description_preview}"`;
      } else if (statusResp.queue && statusResp.queue.pending > 0) {
        panelQueueStatus.textContent = `${statusResp.queue.pending} reports queued`;
      } else {
        panelQueueStatus.textContent = 'Idle \u2014 queue empty';
      }

      if (statusResp.daemon.tmux_attach_command) {
        tmuxCmd = statusResp.daemon.tmux_attach_command;
        panelTerminalBtn.style.display = 'flex';
      }
    });
  });
}

// Check every 10 seconds
setInterval(checkPanelQueueStatus, 10000);
checkPanelQueueStatus();

// ============================================================
// Buttons
// ============================================================

panelReportBtn.addEventListener('click', () => {
  panelReportBtn.disabled = true;
  panelReportBtn.textContent = 'Capturing...';

  // Get current tab mapping and start capture
  chrome.runtime.sendMessage({ action: 'getCurrentTabMapping', tabId }, (response) => {
    if (!response || !response.mapping) {
      panelReportBtn.disabled = false;
      panelReportBtn.textContent = 'Report Bug';
      showPanelToast('No repo configured for this site. Set one in the popup.');
      return;
    }

    chrome.runtime.sendMessage({
      action: 'startCapture',
      tabId,
      mapping: response.mapping,
      hostname: response.hostname
    }, (captureResponse) => {
      panelReportBtn.disabled = false;
      panelReportBtn.textContent = 'Report Bug';

      if (captureResponse && captureResponse.success) {
        showPanelToast('Bug report sent!');
      } else if (captureResponse && captureResponse.cancelled) {
        // User cancelled
      } else {
        showPanelToast(`Error: ${captureResponse ? captureResponse.error : 'Unknown'}`);
      }
    });
  });
});

panelClearBtn.addEventListener('click', () => {
  entries.length = 0;
  consoleErrors = [];
  networkErrorsList.innerHTML = '<div class="empty-list">No network errors captured yet</div>';
  consoleErrorsList.innerHTML = '<div class="empty-list">No console errors captured yet</div>';
  requestCountEl.textContent = '0';
  errorCountEl.textContent = '0';
  storeHarInBackground();
});

panelTerminalBtn.addEventListener('click', () => {
  if (tmuxCmd) {
    navigator.clipboard.writeText(tmuxCmd).then(() => {
      showPanelToast(`Copied: ${tmuxCmd}`);
    });
  }
});

function showPanelToast(text) {
  panelToast.textContent = text;
  panelToast.classList.add('visible');
  setTimeout(() => panelToast.classList.remove('visible'), 3000);
}
