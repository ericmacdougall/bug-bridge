/**
 * Manages hostname-to-repo-path mappings in chrome.storage.local.
 * @module repo-mapper
 */

const REPO_MAPPINGS = 'repoMappings';

/**
 * Gets the mapping object for a hostname.
 * @param {string} hostname - The hostname+port key (e.g., "localhost:3000")
 * @returns {Promise<object|null>} The mapping object, or null if not set
 */
async function getMapping(hostname) {
  try {
    const result = await chrome.storage.local.get(REPO_MAPPINGS);
    const mappings = result[REPO_MAPPINGS] || {};
    return mappings[hostname] || null;
  } catch (err) {
    console.error(`Bug Bridge: Failed to get mapping for ${hostname}:`, err);
    return null;
  }
}

/**
 * Saves or updates the mapping for a hostname.
 * @param {string} hostname - The hostname+port key
 * @param {string} repoPath - Absolute path to the repo
 * @param {string} [label] - Optional label (auto-generated from path if not provided)
 * @returns {Promise<void>}
 */
async function setMapping(hostname, repoPath, label) {
  try {
    const result = await chrome.storage.local.get(REPO_MAPPINGS);
    const mappings = result[REPO_MAPPINGS] || {};

    if (!label) {
      // Auto-generate label from last path segment
      const segments = repoPath.replace(/[\\/]+$/, '').split(/[\\/]/);
      label = segments[segments.length - 1] || repoPath;
    }

    mappings[hostname] = {
      repoPath,
      label,
      lastUsed: new Date().toISOString()
    };

    await chrome.storage.local.set({ [REPO_MAPPINGS]: mappings });
  } catch (err) {
    console.error(`Bug Bridge: Failed to set mapping for ${hostname}:`, err);
    throw new Error(`Failed to save mapping: ${err.message}`);
  }
}

/**
 * Deletes the mapping for a hostname.
 * @param {string} hostname - The hostname+port key
 * @returns {Promise<void>}
 */
async function removeMapping(hostname) {
  try {
    const result = await chrome.storage.local.get(REPO_MAPPINGS);
    const mappings = result[REPO_MAPPINGS] || {};
    delete mappings[hostname];
    await chrome.storage.local.set({ [REPO_MAPPINGS]: mappings });
  } catch (err) {
    console.error(`Bug Bridge: Failed to remove mapping for ${hostname}:`, err);
    throw new Error(`Failed to remove mapping: ${err.message}`);
  }
}

/**
 * Returns the entire repoMappings object.
 * @returns {Promise<object>} All mappings keyed by hostname
 */
async function getAllMappings() {
  try {
    const result = await chrome.storage.local.get(REPO_MAPPINGS);
    return result[REPO_MAPPINGS] || {};
  } catch (err) {
    console.error('Bug Bridge: Failed to get all mappings:', err);
    return {};
  }
}

/**
 * Returns mappings sorted by lastUsed descending, limited to `limit` entries.
 * @param {number} [limit=5] - Maximum number of entries to return
 * @returns {Promise<Array<{hostname: string, repoPath: string, label: string, lastUsed: string}>>}
 */
async function getRecentMappings(limit = 5) {
  try {
    const mappings = await getAllMappings();
    const entries = Object.entries(mappings).map(([hostname, data]) => ({
      hostname,
      ...data
    }));

    entries.sort((a, b) => {
      const dateA = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
      const dateB = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
      return dateB - dateA;
    });

    return entries.slice(0, limit);
  } catch (err) {
    console.error('Bug Bridge: Failed to get recent mappings:', err);
    return [];
  }
}

/**
 * Parses a URL string and returns the hostname+port key.
 * Port is only included if non-standard (not 80 for http, not 443 for https).
 * @param {string} url - The URL to parse
 * @returns {string} The hostname+port key (e.g., "localhost:3000", "example.com")
 */
function extractHostname(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    const port = parsed.port;
    const protocol = parsed.protocol;

    // Include port only if non-standard
    if (port && !(protocol === 'http:' && port === '80') && !(protocol === 'https:' && port === '443')) {
      return `${hostname}:${port}`;
    }

    return hostname;
  } catch (err) {
    console.error('Bug Bridge: Failed to parse URL:', url, err);
    return url;
  }
}
