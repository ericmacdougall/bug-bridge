/**
 * Orchestrates the full bug capture flow.
 * Coordinates screenshot, console errors, page source, cookies, metadata,
 * annotation, HAR, and native messaging.
 * @module capture
 */

/**
 * Captures the full debugging context and sends it to the native host.
 * @param {object} options
 * @param {chrome.tabs.Tab} options.tab - The active tab
 * @param {object} options.mapping - The repo mapping for this site
 * @param {string} options.hostname - The current hostname
 * @param {function} [options.onStatus] - Status callback for UI updates
 * @returns {Promise<object>} The native host response
 */
async function captureAndSend({ tab, mapping, hostname, onStatus }) {
  const status = onStatus || (() => {});

  try {
    // Step 1: Update lastUsed on the mapping
    status('Preparing...');

    // Step 2: Capture screenshot
    status('Capturing screenshot...');
    let screenshotRaw = null;
    try {
      screenshotRaw = await chrome.tabs.captureVisibleTab(null, { format: 'png', quality: 100 });
    } catch (err) {
      console.error('Bug Bridge: Screenshot capture failed:', err);
    }

    // Step 3: Open annotation overlay and wait for user
    status('Waiting for annotation...');
    let annotationResult = null;
    try {
      annotationResult = await openAnnotationOverlay(tab.id, screenshotRaw);
    } catch (err) {
      console.error('Bug Bridge: Annotation overlay failed:', err);
      // Fall back to no annotation
      annotationResult = { cancelled: false, annotatedScreenshot: null, description: '' };
    }

    if (annotationResult && annotationResult.cancelled) {
      return { success: false, cancelled: true };
    }

    // Step 4: Capture everything in parallel
    status('Capturing page data...');

    const [consoleErrors, pageSource, cookies, pageInfo, harData] = await Promise.all([
      getConsoleErrors(tab.id),
      getPageSource(tab.id),
      getCookies(tab.url),
      getPageInfo(tab.id),
      getHarData(tab.id)
    ]);

    // Step 5: Assemble bundle
    status('Assembling report...');

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
      screenshot_annotated: annotationResult ? annotationResult.annotatedScreenshot : null,
      description: annotationResult ? annotationResult.description : '',
      console_errors: consoleErrors,
      network_har: harData ? harData.har : null,
      network_errors_only: harData ? harData.errorsOnly : [],
      cookies: cookies,
      page_source: pageSource,
      meta: meta
    };

    // Step 6: Send to native host
    status('Sending to native host...');
    const response = await sendToNativeHost(bundle);

    // Step 7: Show toast on page
    if (response.success) {
      const toastText = response.queue_position === 1 && response.daemon && response.daemon.started
        ? '\u2713 Bug report sent \u2014 Claude Code is starting...'
        : `\u2713 Bug report queued (#${response.queue_position} in queue)`;

      const tmuxCmd = response.daemon ? response.daemon.tmux_attach_command : '';
      const subtext = tmuxCmd ? `Run \`${tmuxCmd}\` to watch Claude Code work` : '';

      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'showToast',
          text: toastText,
          subtext: subtext,
          clipboardText: tmuxCmd,
          duration: 5000
        });
      } catch (err) {
        console.error('Bug Bridge: Could not show toast:', err);
      }
    }

    return response;
  } catch (err) {
    console.error('Bug Bridge: Capture failed:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Opens the annotation overlay on a tab and waits for the user to finish.
 * @param {number} tabId - The tab ID
 * @param {string|null} screenshotDataUrl - The raw screenshot data URL
 * @returns {Promise<{cancelled: boolean, annotatedScreenshot: string|null, description: string}>}
 */
async function openAnnotationOverlay(tabId, screenshotDataUrl) {
  return new Promise((resolve) => {
    // Set up a listener for the annotation result
    const listener = (message, sender, sendResponse) => {
      if (message.action === 'annotationComplete' && sender.tab && sender.tab.id === tabId) {
        chrome.runtime.onMessage.removeListener(listener);
        resolve({
          cancelled: false,
          annotatedScreenshot: message.annotatedScreenshot || null,
          description: message.description || ''
        });
        sendResponse({ received: true });
        return true;
      }
      if (message.action === 'annotationCancelled' && sender.tab && sender.tab.id === tabId) {
        chrome.runtime.onMessage.removeListener(listener);
        resolve({ cancelled: true, annotatedScreenshot: null, description: '' });
        sendResponse({ received: true });
        return true;
      }
    };

    chrome.runtime.onMessage.addListener(listener);

    // Inject the annotation overlay
    chrome.scripting.executeScript({
      target: { tabId },
      func: injectAnnotationOverlay,
      args: [screenshotDataUrl]
    }).catch((err) => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve({ cancelled: false, annotatedScreenshot: null, description: '' });
    });
  });
}

/**
 * Injected into the page to create the annotation overlay.
 * @param {string|null} screenshotDataUrl - The raw screenshot
 */
function injectAnnotationOverlay(screenshotDataUrl) {
  // This function is injected into the page context.
  // Check if annotation overlay module exists
  if (window.__bugBridgeAnnotate) {
    window.__bugBridgeAnnotate(screenshotDataUrl);
  } else {
    // No annotation module — just send back empty result
    chrome.runtime.sendMessage({
      action: 'annotationComplete',
      annotatedScreenshot: null,
      description: ''
    });
  }
}

/**
 * Gets console errors from the content script.
 * @param {number} tabId - The tab ID
 * @returns {Promise<Array>} Array of console error entries
 */
async function getConsoleErrors(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'getConsoleErrors' });
    return response.errors || [];
  } catch (err) {
    console.error('Bug Bridge: Could not get console errors:', err);
    return [];
  }
}

/**
 * Gets the full page source HTML.
 * @param {number} tabId - The tab ID
 * @returns {Promise<string>} The page HTML source
 */
async function getPageSource(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML
    });
    return results[0] ? results[0].result : '';
  } catch (err) {
    console.error('Bug Bridge: Could not get page source:', err);
    return '';
  }
}

/**
 * Gets all cookies for a URL.
 * @param {string} url - The page URL
 * @returns {Promise<Array>} Array of cookie objects
 */
async function getCookies(url) {
  try {
    return await chrome.cookies.getAll({ url });
  } catch (err) {
    console.error('Bug Bridge: Could not get cookies:', err);
    return [];
  }
}

/**
 * Gets page info (viewport, userAgent, etc.) from the content script.
 * @param {number} tabId - The tab ID
 * @returns {Promise<object>} Page info object
 */
async function getPageInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'getPageInfo' });
    return response;
  } catch (err) {
    console.error('Bug Bridge: Could not get page info:', err);
    return { viewport: { width: 0, height: 0 }, userAgent: '', screenResolution: { width: 0, height: 0 }, devicePixelRatio: 1 };
  }
}

/**
 * Gets HAR data from the DevTools panel (if open).
 * @param {number} tabId - The tab ID
 * @returns {Promise<{har: object, errorsOnly: Array}|null>} HAR data or null if DevTools not open
 */
async function getHarData(tabId) {
  try {
    // Try to get HAR from the devtools panel via background message relay
    return await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 1000);

      chrome.runtime.sendMessage({ action: 'getHar', tabId }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError || !response) {
          resolve(null);
          return;
        }
        resolve(response);
      });
    });
  } catch (err) {
    return null;
  }
}

/**
 * Sends the bundle to the native host.
 * @param {object} bundle - The assembled bug report bundle
 * @returns {Promise<object>} The native host response
 */
async function sendToNativeHost(bundle) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage('com.bugbridge.host', bundle, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          success: false,
          error: `Native host error: ${chrome.runtime.lastError.message}. Run \`npx bug-bridge init\` to set up.`
        });
        return;
      }
      resolve(response || { success: false, error: 'No response from native host' });
    });
  });
}
