/**
 * Background service worker for Bug Bridge (Manifest V3).
 * Handles native messaging, screenshot capture, and coordinates capture flow.
 */

// Store console errors per tab
const tabErrors = new Map();

// Store HAR data per tab (populated by DevTools panel)
const tabHarData = new Map();

// Track which tabs have DevTools open
const devToolsTabs = new Set();

/**
 * Handles messages from content scripts, popup, DevTools panel, etc.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  switch (message.action) {
    case 'consoleErrorsBatch': {
      // Batch of console errors from content script
      if (tabId) {
        const existing = tabErrors.get(tabId) || [];
        const combined = [...existing, ...message.errors];
        // Cap at 500
        tabErrors.set(tabId, combined.slice(-500));
      }
      sendResponse({ received: true });
      return true;
    }

    case 'ping': {
      // Ping the native host
      chrome.runtime.sendNativeMessage('com.bugbridge.host', { action: 'ping' }, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse(response);
      });
      return true;
    }

    case 'nativeStatus': {
      // Get status from native host
      chrome.runtime.sendNativeMessage('com.bugbridge.host', { action: 'status', repo_path: message.repoPath }, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse(response);
      });
      return true;
    }

    case 'startCapture': {
      // Start the full capture flow
      handleCapture(message).then(sendResponse);
      return true;
    }

    case 'getHar': {
      // Request HAR data — check if we have it stored from DevTools panel
      const harTabId = message.tabId;
      const harData = tabHarData.get(harTabId);
      sendResponse(harData || null);
      return true;
    }

    case 'storeHar': {
      // DevTools panel stores HAR data
      if (message.tabId) {
        tabHarData.set(message.tabId, {
          har: message.har,
          errorsOnly: message.errorsOnly
        });
      }
      sendResponse({ received: true });
      return true;
    }

    case 'devtoolsOpened': {
      if (message.tabId) {
        devToolsTabs.add(message.tabId);
      }
      sendResponse({ received: true });
      return true;
    }

    case 'devtoolsClosed': {
      if (message.tabId) {
        devToolsTabs.delete(message.tabId);
        tabHarData.delete(message.tabId);
      }
      sendResponse({ received: true });
      return true;
    }

    case 'isDevToolsOpen': {
      const isOpen = devToolsTabs.has(message.tabId);
      sendResponse({ open: isOpen });
      return true;
    }

    case 'getCurrentTabMapping': {
      // Get the repo mapping for a tab (used by DevTools panel)
      getTabMapping(message.tabId).then(sendResponse);
      return true;
    }

    case 'getConsoleErrorsForTab': {
      // Relay console errors request to the content script
      chrome.tabs.sendMessage(message.tabId, { action: 'getConsoleErrors' }, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ errors: tabErrors.get(message.tabId) || [] });
          return;
        }
        sendResponse(response || { errors: [] });
      });
      return true;
    }

    default:
      return false;
  }
});

/**
 * Handles the full capture flow triggered by popup or DevTools panel.
 * @param {object} message - The capture request with tab info and mapping
 * @returns {Promise<object>} The result
 */
async function handleCapture(message) {
  try {
    const { tabId, mapping, hostname } = message;

    // Get the tab
    const tab = await chrome.tabs.get(tabId);

    // Capture screenshot
    let screenshotRaw = null;
    try {
      screenshotRaw = await chrome.tabs.captureVisibleTab(null, { format: 'png', quality: 100 });
    } catch (err) {
      console.error('Bug Bridge: Screenshot capture failed:', err);
    }

    // Open annotation overlay and wait for result
    const annotationResult = await new Promise((resolve) => {
      const listener = (msg, sender, respond) => {
        if (sender.tab && sender.tab.id === tabId) {
          if (msg.action === 'annotationComplete') {
            chrome.runtime.onMessage.removeListener(listener);
            resolve({
              cancelled: false,
              annotatedScreenshot: msg.annotatedScreenshot || null,
              description: msg.description || ''
            });
            respond({ received: true });
            return true;
          }
          if (msg.action === 'annotationCancelled') {
            chrome.runtime.onMessage.removeListener(listener);
            resolve({ cancelled: true });
            respond({ received: true });
            return true;
          }
        }
      };

      chrome.runtime.onMessage.addListener(listener);

      // First inject annotate.js to make __bugBridgeAnnotate available, then invoke it
      chrome.scripting.executeScript({
        target: { tabId },
        files: ['annotate.js']
      }).then(() => {
        return chrome.scripting.executeScript({
          target: { tabId },
          func: (ssDataUrl) => {
            if (window.__bugBridgeAnnotate) {
              window.__bugBridgeAnnotate(ssDataUrl);
            } else {
              chrome.runtime.sendMessage({
                action: 'annotationComplete',
                annotatedScreenshot: null,
                description: ''
              });
            }
          },
          args: [screenshotRaw]
        });
      }).catch(() => {
        chrome.runtime.onMessage.removeListener(listener);
        resolve({ cancelled: false, annotatedScreenshot: null, description: '' });
      });
    });

    if (annotationResult.cancelled) {
      return { success: false, cancelled: true };
    }

    // Capture all data in parallel
    const [consoleErrors, pageSource, cookies, pageInfo, harData] = await Promise.all([
      getConsoleErrors(tabId),
      getPageSource(tabId),
      getCookies(tab.url),
      getPageInfo(tabId),
      getHarDataForTab(tabId)
    ]);

    // Assemble bundle
    const meta = {
      url: tab.url,
      title: tab.title,
      timestamp: new Date().toISOString(),
      viewport: pageInfo.viewport || { width: 0, height: 0 },
      userAgent: pageInfo.userAgent || '',
      screenResolution: pageInfo.screenResolution || { width: 0, height: 0 },
      devicePixelRatio: pageInfo.devicePixelRatio || 1
    };

    const bundle = {
      version: '1',
      repo_path: mapping.repoPath,
      screenshot_raw: screenshotRaw,
      screenshot_annotated: annotationResult.annotatedScreenshot || null,
      description: annotationResult.description || '',
      console_errors: consoleErrors,
      network_har: harData ? harData.har : null,
      network_errors_only: harData ? harData.errorsOnly : [],
      cookies: cookies,
      page_source: pageSource,
      meta: meta
    };

    // Send to native host (with chunked streaming for large bundles)
    const response = await sendBundleToNativeHost(bundle);

    // Show toast on the page
    if (response.success) {
      const toastText = response.queue_position === 1 && response.daemon && response.daemon.started
        ? '\u2713 Bug report sent \u2014 Claude Code is starting...'
        : `\u2713 Bug report queued (#${response.queue_position} in queue)`;

      const tmuxCmd = response.daemon ? response.daemon.tmux_attach_command : '';

      try {
        await chrome.tabs.sendMessage(tabId, {
          action: 'showToast',
          text: toastText,
          subtext: tmuxCmd ? `Run \`${tmuxCmd}\` to watch Claude Code work` : '',
          clipboardText: tmuxCmd,
          duration: 5000
        });
      } catch (e) {
        // Tab might be closed
      }
    }

    return response;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Gets console errors from the content script.
 * @param {number} tabId
 * @returns {Promise<Array>}
 */
async function getConsoleErrors(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'getConsoleErrors' });
    return response.errors || [];
  } catch (err) {
    // Fallback to stored errors
    return tabErrors.get(tabId) || [];
  }
}

/**
 * Gets the page source HTML.
 * @param {number} tabId
 * @returns {Promise<string>}
 */
async function getPageSource(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML
    });
    return results[0] ? results[0].result : '';
  } catch (err) {
    return '';
  }
}

/**
 * Gets cookies for a URL.
 * @param {string} url
 * @returns {Promise<Array>}
 */
async function getCookies(url) {
  try {
    return await chrome.cookies.getAll({ url });
  } catch (err) {
    return [];
  }
}

/**
 * Gets page info from the content script.
 * @param {number} tabId
 * @returns {Promise<object>}
 */
async function getPageInfo(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { action: 'getPageInfo' });
  } catch (err) {
    return { viewport: { width: 0, height: 0 }, userAgent: '', screenResolution: { width: 0, height: 0 }, devicePixelRatio: 1 };
  }
}

/**
 * Gets HAR data stored by the DevTools panel for a tab.
 * @param {number} tabId
 * @returns {Promise<object|null>}
 */
async function getHarDataForTab(tabId) {
  return tabHarData.get(tabId) || null;
}

/** Maximum size for a single native message (Chrome limit ~1MB) */
const MAX_NATIVE_MESSAGE_SIZE = 1024 * 1024;

/**
 * Sends a bug report bundle to the native host.
 * Uses chunked streaming via connectNative if the bundle exceeds the 1MB limit.
 * @param {object} bundle - The bug report bundle
 * @returns {Promise<object>} The native host response
 */
async function sendBundleToNativeHost(bundle) {
  const json = JSON.stringify(bundle);
  const size = Buffer.byteLength ? Buffer.byteLength(json, 'utf8') : json.length * 2;

  if (size <= MAX_NATIVE_MESSAGE_SIZE) {
    // Small enough for single message
    return new Promise((resolve) => {
      chrome.runtime.sendNativeMessage('com.bugbridge.host', bundle, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({
            success: false,
            error: `Native host error: ${chrome.runtime.lastError.message}. Run \`npx bug-bridge init\` to set up.`
          });
          return;
        }
        resolve(resp || { success: false, error: 'No response from native host' });
      });
    });
  }

  // Large bundle — use chunked streaming via connectNative
  return new Promise((resolve) => {
    let responded = false;
    const port = chrome.runtime.connectNative('com.bugbridge.host');

    port.onMessage.addListener((response) => {
      if (!responded) {
        responded = true;
        try { port.disconnect(); } catch (e) { /* ignore */ }
        resolve(response);
      }
    });

    port.onDisconnect.addListener(() => {
      if (!responded) {
        responded = true;
        const error = chrome.runtime.lastError
          ? chrome.runtime.lastError.message
          : 'Native host disconnected';
        resolve({
          success: false,
          error: `Native host error: ${error}. Run \`npx bug-bridge init\` to set up.`
        });
      }
    });

    // Send metadata (everything except large fields)
    const largeFields = ['screenshot_raw', 'screenshot_annotated', 'page_source', 'network_har'];
    const metaMessage = { ...bundle, _chunked: true };

    for (const field of largeFields) {
      if (metaMessage[field]) {
        metaMessage[field] = null;
        metaMessage[`_has_${field}`] = true;
      }
    }
    port.postMessage(metaMessage);

    // Send each large field as chunks
    const chunkSize = 900 * 1024; // Stay under 1MB per chunk
    for (const field of largeFields) {
      if (bundle[field]) {
        const value = typeof bundle[field] === 'string'
          ? bundle[field]
          : JSON.stringify(bundle[field]);
        const totalChunks = Math.ceil(value.length / chunkSize);

        for (let i = 0; i < totalChunks; i++) {
          port.postMessage({
            _chunk: true,
            field,
            index: i,
            total: totalChunks,
            data: value.substring(i * chunkSize, (i + 1) * chunkSize)
          });
        }
      }
    }

    // Signal completion
    port.postMessage({ _chunk_complete: true });
  });
}

/**
 * Gets the repo mapping for a tab by its URL hostname.
 * @param {number} tabId
 * @returns {Promise<{mapping: object|null, hostname: string}>}
 */
async function getTabMapping(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url) return { mapping: null, hostname: '' };

    const hostname = extractHostname(tab.url);
    const result = await chrome.storage.local.get('repoMappings');
    const mappings = result.repoMappings || {};
    const mapping = mappings[hostname] || null;
    return { mapping, hostname };
  } catch (err) {
    return { mapping: null, hostname: '' };
  }
}

/**
 * Extracts hostname+port from a URL (background script version).
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

// Clean up tab data when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabErrors.delete(tabId);
  tabHarData.delete(tabId);
  devToolsTabs.delete(tabId);
});
