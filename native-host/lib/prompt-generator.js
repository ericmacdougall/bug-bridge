/**
 * Generates the prompt.md file for Claude Code from a bug report bundle.
 * @module prompt-generator
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Generates prompt.md content from a bug report bundle.
 * @param {object} bundle - The bug report bundle
 * @param {string} reportDir - Absolute path to the report directory
 * @param {string} repoPath - Absolute path to the repo root
 * @returns {string} The generated markdown content
 */
function generatePrompt(bundle, reportDir, repoPath) {
  const meta = bundle.meta || {};
  const description = bundle.description || '(No description provided)';
  const consoleErrors = bundle.console_errors || [];
  const networkHar = bundle.network_har;
  const networkErrors = bundle.network_errors_only || [];
  const cookies = bundle.cookies || [];
  const pageSource = bundle.page_source || '';
  const hasAnnotated = !!bundle.screenshot_annotated;

  // Compute relative path from repo root
  const relativePath = path.relative(repoPath, reportDir);

  // Count console error types
  const errorCount = consoleErrors.filter(e => e.level === 'error' || e.level === 'unhandled_exception' || e.level === 'unhandled_rejection').length;
  const warnCount = consoleErrors.filter(e => e.level === 'warn').length;

  // Count network requests
  const totalRequests = networkHar && networkHar.log && networkHar.log.entries ? networkHar.log.entries.length : 0;
  const errorRequestCount = networkErrors.length;

  // Cookie count
  const cookieCount = cookies.length;

  // Page source size
  const pageSizeKb = (Buffer.byteLength(pageSource, 'utf8') / 1024).toFixed(1);

  // Viewport
  const viewport = meta.viewport || { width: 0, height: 0 };

  let md = `# Bug Report — ${meta.title || 'Untitled Page'}

**URL:** ${meta.url || 'unknown'}
**Reported:** ${meta.timestamp || new Date().toISOString()}
**Viewport:** ${viewport.width}x${viewport.height}
**User Agent:** ${meta.userAgent || 'unknown'}

## User Description

${description}

## What was captured

The following context files are in this directory (\`${relativePath}\`):

- \`screenshot-raw.png\` — Full page screenshot at time of report
`;

  if (hasAnnotated) {
    md += `- \`screenshot-annotated.png\` — Screenshot with user's annotations highlighting the problem area\n`;
  }

  md += `- \`console-errors.json\` — ${consoleErrors.length} console errors/warnings captured (${errorCount} errors, ${warnCount} warnings)
`;

  if (networkHar) {
    md += `- \`network-full.har\` — Full HAR log of ${totalRequests} network requests\n`;
  } else {
    md += `- *(No network HAR captured — DevTools was not open)*\n`;
  }

  md += `- \`network-errors.json\` — ${errorRequestCount} failed/errored network requests
- \`cookies.json\` — ${cookieCount} cookies for this domain
- \`page-source.html\` — Full page HTML source (${pageSizeKb} KB)
- \`meta.json\` — Browser and viewport metadata

## Suggested approach

1. Start by reading my description above and looking at the annotated screenshot if present
2. Check \`console-errors.json\` for any JavaScript errors that might explain the issue
3. Check \`network-errors.json\` for any failed API calls or resource loading failures
4. If the issue seems related to rendering/layout, examine \`page-source.html\`
5. Use the repo's source code to find and fix the root cause
6. Only read files that seem relevant — you don't need to read everything

Please diagnose this bug and implement a fix.
`;

  return md;
}

/**
 * Writes the prompt.md file to the report directory.
 * @param {object} bundle - The bug report bundle
 * @param {string} reportDir - Absolute path to the report directory
 * @param {string} repoPath - Absolute path to the repo root
 */
function writePrompt(bundle, reportDir, repoPath) {
  const content = generatePrompt(bundle, reportDir, repoPath);
  fs.writeFileSync(path.join(reportDir, 'prompt.md'), content, 'utf8');
}

module.exports = { generatePrompt, writePrompt };
