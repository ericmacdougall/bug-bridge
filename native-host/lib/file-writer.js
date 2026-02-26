/**
 * Writes bug report bundle files to disk.
 * @module file-writer
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Decodes a data URL to a Buffer.
 * @param {string} dataUrl - A data URL (e.g., "data:image/png;base64,...")
 * @returns {Buffer} The decoded binary data
 */
function decodeDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid data URL format');
  }
  return Buffer.from(match[1], 'base64');
}

/**
 * Generates a unique report directory path based on timestamp.
 * @param {string} repoPath - Absolute path to the repo
 * @returns {{ dir: string, id: string }} The directory path and report ID
 */
function generateReportDir(repoPath) {
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const id = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  let dir = path.join(repoPath, '.bug-reports', id);
  let suffix = 0;

  while (fs.existsSync(dir)) {
    suffix++;
    dir = path.join(repoPath, '.bug-reports', `${id}-${suffix}`);
  }

  const finalId = suffix > 0 ? `${id}-${suffix}` : id;
  return { dir, id: finalId };
}

/**
 * Writes all bundle files to the report directory.
 * @param {object} bundle - The bug report bundle from the Chrome extension
 * @param {string} bundle.repo_path - Absolute path to the repo
 * @param {string} bundle.screenshot_raw - Raw screenshot as data URL
 * @param {string|null} bundle.screenshot_annotated - Annotated screenshot as data URL, or null
 * @param {string} bundle.description - User's bug description text
 * @param {Array} bundle.console_errors - Array of console error entries
 * @param {object|null} bundle.network_har - Full HAR object, or null
 * @param {Array|null} bundle.network_errors_only - Array of network error entries, or null
 * @param {Array} bundle.cookies - Array of cookie objects
 * @param {string} bundle.page_source - Full page HTML source
 * @param {object} bundle.meta - Metadata object
 * @returns {{ dir: string, id: string, filesWritten: number, errors: string[] }} Write results
 */
function writeBundle(bundle) {
  const { dir, id } = generateReportDir(bundle.repo_path);

  fs.mkdirSync(dir, { recursive: true });

  const filesWritten = [];
  const errors = [];

  const writeFile = (filename, content, encoding) => {
    try {
      const filePath = path.join(dir, filename);
      if (encoding === 'binary') {
        fs.writeFileSync(filePath, content);
      } else {
        fs.writeFileSync(filePath, content, { encoding: 'utf8' });
      }
      const stat = fs.statSync(filePath);
      filesWritten.push({ name: filename, size: stat.size });
    } catch (err) {
      errors.push(`Failed to write ${filename}: ${err.message}`);
    }
  };

  // Screenshot raw
  if (bundle.screenshot_raw) {
    try {
      const pngBuffer = decodeDataUrl(bundle.screenshot_raw);
      writeFile('screenshot-raw.png', pngBuffer, 'binary');
    } catch (err) {
      errors.push(`Failed to decode screenshot-raw: ${err.message}`);
    }
  }

  // Screenshot annotated
  if (bundle.screenshot_annotated) {
    try {
      const pngBuffer = decodeDataUrl(bundle.screenshot_annotated);
      writeFile('screenshot-annotated.png', pngBuffer, 'binary');
    } catch (err) {
      errors.push(`Failed to decode screenshot-annotated: ${err.message}`);
    }
  }

  // Description
  writeFile('description.txt', bundle.description || '', 'utf8');

  // Console errors
  writeFile('console-errors.json', JSON.stringify(bundle.console_errors || [], null, 2), 'utf8');

  // Network HAR
  if (bundle.network_har) {
    writeFile('network-full.har', JSON.stringify(bundle.network_har, null, 2), 'utf8');
  }

  // Network errors
  writeFile('network-errors.json', JSON.stringify(bundle.network_errors_only || [], null, 2), 'utf8');

  // Cookies
  writeFile('cookies.json', JSON.stringify(bundle.cookies || [], null, 2), 'utf8');

  // Page source
  writeFile('page-source.html', bundle.page_source || '', 'utf8');

  // Meta
  writeFile('meta.json', JSON.stringify(bundle.meta || {}, null, 2), 'utf8');

  // Write manifest
  const manifest = {
    id,
    created: new Date().toISOString(),
    files: filesWritten,
    errors: errors.length > 0 ? errors : undefined
  };
  writeFile('manifest.json', JSON.stringify(manifest, null, 2), 'utf8');

  return {
    dir,
    id,
    filesWritten: filesWritten.length,
    errors
  };
}

module.exports = { writeBundle, generateReportDir, decodeDataUrl };
