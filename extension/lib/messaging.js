/**
 * Wrapper around chrome.runtime.sendNativeMessage for the Bug Bridge native host.
 * @module messaging
 */

const NATIVE_HOST_NAME = 'com.bugbridge.host';

/**
 * Sends a message to the native host and returns the response.
 * @param {object} message - The message to send
 * @returns {Promise<object>} The response from the native host
 */
function sendNativeMessage(message) {
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
 * Sends a ping to the native host to check if it's available.
 * @param {number} [timeoutMs=3000] - Timeout in milliseconds
 * @returns {Promise<{success: boolean, version?: string, error?: string}>}
 */
async function ping(timeoutMs = 3000) {
  try {
    const result = await Promise.race([
      sendNativeMessage({ action: 'ping' }),
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
    return await sendNativeMessage({ action: 'status', repo_path: repoPath });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Sends a bug report bundle to the native host.
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
