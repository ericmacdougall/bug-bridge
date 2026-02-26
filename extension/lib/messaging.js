/**
 * Wrapper around chrome.runtime.sendNativeMessage for the Bug Bridge native host.
 * Supports both single-message and chunked (connectNative) approaches for large bundles.
 * @module messaging
 */

const NATIVE_HOST_NAME = 'com.bugbridge.host';

/** Maximum size for a single native message (Chrome limit is 1MB) */
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB

/**
 * Sends a message to the native host and returns the response.
 * For messages under 1MB, uses sendNativeMessage.
 * For larger messages, uses connectNative with chunked streaming.
 * @param {object} message - The message to send
 * @returns {Promise<object>} The response from the native host
 */
function sendNativeMessage(message) {
  const json = JSON.stringify(message);
  const size = new Blob([json]).size;

  if (size <= MAX_MESSAGE_SIZE) {
    return sendSmallMessage(message);
  } else {
    return sendChunkedMessage(message);
  }
}

/**
 * Sends a small message using chrome.runtime.sendNativeMessage.
 * @param {object} message - The message to send
 * @returns {Promise<object>} The response
 */
function sendSmallMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Sends a large message using chrome.runtime.connectNative with chunked streaming.
 * Splits the bundle into metadata + separate chunks for large fields.
 * @param {object} message - The message to send
 * @returns {Promise<object>} The response
 */
function sendChunkedMessage(message) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    let responded = false;

    port.onMessage.addListener((response) => {
      if (!responded) {
        responded = true;
        port.disconnect();
        resolve(response);
      }
    });

    port.onDisconnect.addListener(() => {
      if (!responded) {
        responded = true;
        const error = chrome.runtime.lastError
          ? chrome.runtime.lastError.message
          : 'Native host disconnected';
        reject(new Error(error));
      }
    });

    // Send the bundle in chunks:
    // 1. First message: metadata (everything except large fields)
    // 2. Subsequent messages: large fields one at a time
    // 3. Final message: { action: "chunk_complete" }

    const largeFields = ['screenshot_raw', 'screenshot_annotated', 'page_source', 'network_har'];
    const metaMessage = { ...message, _chunked: true };

    // Remove large fields from the initial message
    for (const field of largeFields) {
      if (metaMessage[field]) {
        metaMessage[field] = null;
        metaMessage[`_has_${field}`] = true;
      }
    }

    // Send metadata
    port.postMessage(metaMessage);

    // Send each large field as a separate chunk
    for (const field of largeFields) {
      if (message[field]) {
        const value = typeof message[field] === 'string'
          ? message[field]
          : JSON.stringify(message[field]);

        // Split into sub-chunks if needed (stay under 900KB per message for safety)
        const chunkSize = 900 * 1024;
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
 * Sends a ping to the native host to check if it's available.
 * @param {number} [timeoutMs=3000] - Timeout in milliseconds
 * @returns {Promise<{success: boolean, version?: string, error?: string}>}
 */
async function ping(timeoutMs = 3000) {
  try {
    const result = await Promise.race([
      sendSmallMessage({ action: 'ping' }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Ping timed out')), timeoutMs)
      )
    ]);
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Sends a status request to the native host.
 * @param {string} repoPath - The repo path to check status for
 * @returns {Promise<object>} Status response from native host
 */
async function getStatus(repoPath) {
  try {
    return await sendSmallMessage({ action: 'status', repo_path: repoPath });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Sends a bug report bundle to the native host.
 * Automatically uses chunked streaming if the bundle is too large.
 * @param {object} bundle - The bug report bundle
 * @returns {Promise<object>} Response from native host
 */
async function sendBugReport(bundle) {
  try {
    return await sendNativeMessage(bundle);
  } catch (err) {
    return { success: false, error: err.message };
  }
}
