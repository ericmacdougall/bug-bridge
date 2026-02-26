/**
 * Bug Bridge Popup Script.
 * Manages the popup UI for repo mapping, status display, and bug reporting.
 */

'use strict';

// Storage key
const REPO_MAPPINGS = 'repoMappings';

// DOM elements
const currentHostnameEl = document.getElementById('current-hostname');
const currentMappingEl = document.getElementById('current-mapping');
const repoPathInput = document.getElementById('repo-path');
const repoLabelInput = document.getElementById('repo-label');
const saveBtnEl = document.getElementById('save-btn');
const removeBtnEl = document.getElementById('remove-btn');
const saveFeedbackEl = document.getElementById('save-feedback');
const pathErrorEl = document.getElementById('path-error');
const pathWarningEl = document.getElementById('path-warning');
const recentListEl = document.getElementById('recent-list');
const recentEmptyEl = document.getElementById('recent-empty');
const queueSectionEl = document.getElementById('queue-section');
const queueStatusEl = document.getElementById('queue-status');
const terminalBtnEl = document.getElementById('terminal-btn');
const nativeStatusDot = document.getElementById('native-status-dot');
const nativeStatusText = document.getElementById('native-status-text');
const devtoolsStatusDot = document.getElementById('devtools-status-dot');
const devtoolsStatusText = document.getElementById('devtools-status-text');
const reportBtnEl = document.getElementById('report-btn');
const popupToast = document.getElementById('popup-toast');

let currentTab = null;
let currentHostname = '';
let currentMapping = null;
let tmuxAttachCommand = '';

// ============================================================
// Repo Mapper functions (inline to avoid ES module issues in popup)
// ============================================================

/**
 * Extracts hostname+port from a URL.
 * @param {string} url
 * @returns {string}
 */
function extractHostname(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    const port = parsed.port;
    const protocol = parsed.protocol;
    if (port && !(protocol === 'http:' && port === '80') && !(protocol === 'https:' && port === '443')) {
      return `${hostname}:${port}`;
    }
    return hostname;
  } catch (err) {
    return url;
  }
}

/**
 * Gets mapping for a hostname.
 * @param {string} hostname
 * @returns {Promise<object|null>}
 */
async function getMapping(hostname) {
  try {
    const result = await chrome.storage.local.get(REPO_MAPPINGS);
    const mappings = result[REPO_MAPPINGS] || {};
    return mappings[hostname] || null;
  } catch (err) {
    return null;
  }
}

/**
 * Sets mapping for a hostname.
 * @param {string} hostname
 * @param {string} repoPath
 * @param {string} [label]
 * @returns {Promise<void>}
 */
async function setMapping(hostname, repoPath, label) {
  const result = await chrome.storage.local.get(REPO_MAPPINGS);
  const mappings = result[REPO_MAPPINGS] || {};
  if (!label) {
    const segments = repoPath.replace(/[\\/]+$/, '').split(/[\\/]/);
    label = segments[segments.length - 1] || repoPath;
  }
  mappings[hostname] = {
    repoPath,
    label,
    lastUsed: new Date().toISOString()
  };
  await chrome.storage.local.set({ [REPO_MAPPINGS]: mappings });
}

/**
 * Removes mapping for a hostname.
 * @param {string} hostname
 * @returns {Promise<void>}
 */
async function removeMapping(hostname) {
  const result = await chrome.storage.local.get(REPO_MAPPINGS);
  const mappings = result[REPO_MAPPINGS] || {};
  delete mappings[hostname];
  await chrome.storage.local.set({ [REPO_MAPPINGS]: mappings });
}

/**
 * Gets recent mappings sorted by lastUsed.
 * @param {number} [limit=5]
 * @returns {Promise<Array>}
 */
async function getRecentMappings(limit = 5) {
  const result = await chrome.storage.local.get(REPO_MAPPINGS);
  const mappings = result[REPO_MAPPINGS] || {};
  const entries = Object.entries(mappings).map(([hostname, data]) => ({ hostname, ...data }));
  entries.sort((a, b) => {
    const dateA = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
    const dateB = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
    return dateB - dateA;
  });
  return entries.slice(0, limit);
}

// ============================================================
// Initialization
// ============================================================

async function init() {
  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    currentHostnameEl.textContent = 'No active tab';
    return;
  }

  currentTab = tab;
  currentHostname = extractHostname(tab.url);
  currentHostnameEl.textContent = currentHostname;

  // Load existing mapping
  currentMapping = await getMapping(currentHostname);
  if (currentMapping) {
    repoPathInput.value = currentMapping.repoPath;
    repoLabelInput.value = currentMapping.label || '';
    currentMappingEl.textContent = currentMapping.repoPath;
    currentMappingEl.classList.add('active');
    removeBtnEl.style.display = 'inline-block';
    reportBtnEl.disabled = false;
    reportBtnEl.title = '';
  } else {
    currentMappingEl.textContent = 'No repo configured for this site';
    currentMappingEl.classList.remove('active');
    removeBtnEl.style.display = 'none';
    reportBtnEl.disabled = true;
    reportBtnEl.title = 'Configure a repo path first';
  }

  // Load recent mappings
  await refreshRecentList();

  // Check native host status
  checkNativeHost();

  // Check DevTools status
  checkDevTools();

  // Check queue/daemon status
  if (currentMapping) {
    checkQueueStatus();
  }
}

// ============================================================
// Recent repos list
// ============================================================

async function refreshRecentList() {
  const recent = await getRecentMappings(5);

  if (recent.length === 0) {
    recentEmptyEl.style.display = 'block';
    // Clear any existing items
    const items = recentListEl.querySelectorAll('.recent-item');
    items.forEach(item => item.remove());
    return;
  }

  recentEmptyEl.style.display = 'none';

  // Clear existing items
  const existingItems = recentListEl.querySelectorAll('.recent-item');
  existingItems.forEach(item => item.remove());

  recent.forEach((entry) => {
    const li = document.createElement('li');
    li.className = 'recent-item';

    const info = document.createElement('div');
    info.className = 'recent-info';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'recent-label';
    labelSpan.textContent = entry.label || 'Unknown';

    const hostnameSpan = document.createElement('span');
    hostnameSpan.className = 'recent-hostname';
    hostnameSpan.textContent = entry.hostname;

    const pathDiv = document.createElement('div');
    pathDiv.className = 'recent-path';
    pathDiv.textContent = entry.repoPath;
    pathDiv.title = entry.repoPath;

    info.appendChild(labelSpan);
    info.appendChild(hostnameSpan);
    info.appendChild(document.createElement('br'));
    info.appendChild(pathDiv);

    const useBtn = document.createElement('button');
    useBtn.className = 'btn btn-small';
    useBtn.textContent = 'Use';
    useBtn.title = 'Use for current site';
    useBtn.addEventListener('click', () => {
      repoPathInput.value = entry.repoPath;
      repoLabelInput.value = entry.label || '';
      repoPathInput.focus();
    });

    li.appendChild(info);
    li.appendChild(useBtn);
    recentListEl.appendChild(li);
  });
}

// ============================================================
// Status checks
// ============================================================

function checkNativeHost() {
  chrome.runtime.sendMessage({ action: 'ping' }, (response) => {
    if (chrome.runtime.lastError || !response || !response.success) {
      nativeStatusDot.className = 'status-dot red';
      nativeStatusText.textContent = 'Native host not found \u2014 run `npx bug-bridge init`';
    } else {
      nativeStatusDot.className = 'status-dot green';
      nativeStatusText.textContent = 'Ready';
    }
  });
}

function checkDevTools() {
  if (!currentTab) return;
  chrome.runtime.sendMessage({ action: 'isDevToolsOpen', tabId: currentTab.id }, (response) => {
    if (chrome.runtime.lastError) {
      devtoolsStatusDot.className = 'status-dot yellow';
      devtoolsStatusText.textContent = 'DevTools closed \u2014 partial capture (no network logs)';
      return;
    }
    if (response && response.open) {
      devtoolsStatusDot.className = 'status-dot green';
      devtoolsStatusText.textContent = 'DevTools open \u2014 full capture';
    } else {
      devtoolsStatusDot.className = 'status-dot yellow';
      devtoolsStatusText.textContent = 'DevTools closed \u2014 partial capture (no network logs)';
    }
  });
}

function checkQueueStatus() {
  if (!currentMapping) {
    queueSectionEl.classList.remove('visible');
    return;
  }

  chrome.runtime.sendMessage({ action: 'nativeStatus', repoPath: currentMapping.repoPath }, (response) => {
    if (chrome.runtime.lastError || !response || !response.success) {
      queueSectionEl.classList.remove('visible');
      return;
    }

    if (!response.daemon || !response.daemon.running) {
      queueSectionEl.classList.remove('visible');
      return;
    }

    queueSectionEl.classList.add('visible');

    if (response.queue && response.queue.processing) {
      queueStatusEl.textContent = `Working on: "${response.queue.processing.description_preview}"`;
      if (response.queue.pending > 0) {
        queueStatusEl.textContent += ` (${response.queue.pending} more queued)`;
      }
    } else if (response.queue && response.queue.pending > 0) {
      queueStatusEl.textContent = `${response.queue.pending} reports queued`;
    } else {
      queueStatusEl.textContent = 'Idle \u2014 queue empty';
    }

    if (response.daemon.tmux_attach_command) {
      tmuxAttachCommand = response.daemon.tmux_attach_command;
      terminalBtnEl.style.display = 'flex';
    }
  });
}

// ============================================================
// Event handlers
// ============================================================

// Save button
saveBtnEl.addEventListener('click', async () => {
  const repoPath = repoPathInput.value.trim();
  const label = repoLabelInput.value.trim();

  // Validation
  pathErrorEl.style.display = 'none';
  pathWarningEl.style.display = 'none';

  if (!repoPath) {
    pathErrorEl.style.display = 'block';
    return;
  }

  // Check for absolute path
  const isAbsolute = repoPath.startsWith('/') || /^[A-Z]:\\/.test(repoPath);
  if (!isAbsolute) {
    pathWarningEl.style.display = 'block';
    // Don't block save — just show warning
  }

  try {
    await setMapping(currentHostname, repoPath, label || undefined);
    currentMapping = await getMapping(currentHostname);

    // Update UI
    currentMappingEl.textContent = repoPath;
    currentMappingEl.classList.add('active');
    removeBtnEl.style.display = 'inline-block';
    reportBtnEl.disabled = false;
    reportBtnEl.title = '';

    // Show feedback
    saveFeedbackEl.classList.add('visible');
    setTimeout(() => saveFeedbackEl.classList.remove('visible'), 2000);

    // Refresh recent list
    await refreshRecentList();

    // Check queue status
    checkQueueStatus();
  } catch (err) {
    pathErrorEl.textContent = err.message;
    pathErrorEl.style.display = 'block';
  }
});

// Remove button
removeBtnEl.addEventListener('click', async () => {
  try {
    await removeMapping(currentHostname);
    currentMapping = null;

    // Reset UI
    repoPathInput.value = '';
    repoLabelInput.value = '';
    currentMappingEl.textContent = 'No repo configured for this site';
    currentMappingEl.classList.remove('active');
    removeBtnEl.style.display = 'none';
    reportBtnEl.disabled = true;
    reportBtnEl.title = 'Configure a repo path first';
    queueSectionEl.classList.remove('visible');

    await refreshRecentList();
  } catch (err) {
    showPopupToast(`Error: ${err.message}`);
  }
});

// Report Bug button
reportBtnEl.addEventListener('click', async () => {
  if (!currentTab || !currentMapping) return;

  reportBtnEl.disabled = true;
  reportBtnEl.textContent = 'Capturing...';

  try {
    // Update lastUsed
    await setMapping(currentHostname, currentMapping.repoPath, currentMapping.label);

    // Close popup — the background script handles the rest
    chrome.runtime.sendMessage({
      action: 'startCapture',
      tabId: currentTab.id,
      mapping: currentMapping,
      hostname: currentHostname
    }, (response) => {
      if (chrome.runtime.lastError) {
        reportBtnEl.textContent = 'Report Bug';
        reportBtnEl.disabled = false;
        showPopupToast(`Error: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (response && response.success) {
        window.close();
      } else if (response && response.cancelled) {
        reportBtnEl.textContent = 'Report Bug';
        reportBtnEl.disabled = false;
      } else {
        reportBtnEl.textContent = 'Report Bug';
        reportBtnEl.disabled = false;
        showPopupToast(`Error: ${response ? response.error : 'Unknown error'}`);
      }
    });
  } catch (err) {
    reportBtnEl.textContent = 'Report Bug';
    reportBtnEl.disabled = false;
    showPopupToast(`Error: ${err.message}`);
  }
});

// Terminal button
terminalBtnEl.addEventListener('click', () => {
  if (tmuxAttachCommand) {
    navigator.clipboard.writeText(tmuxAttachCommand).then(() => {
      showPopupToast(`Copied: ${tmuxAttachCommand}`);
    });
  }
});

// Enter key on inputs
repoPathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveBtnEl.click();
});

repoLabelInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveBtnEl.click();
});

// ============================================================
// Toast
// ============================================================

function showPopupToast(text) {
  popupToast.textContent = text;
  popupToast.classList.add('visible');
  setTimeout(() => popupToast.classList.remove('visible'), 3000);
}

// ============================================================
// Initialize
// ============================================================

init();
