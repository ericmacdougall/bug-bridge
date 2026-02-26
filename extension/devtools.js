/**
 * DevTools page script.
 * Creates the Bug Bridge DevTools panel and captures network requests.
 */

'use strict';

// Create the DevTools panel
chrome.devtools.panels.create(
  'Bug Bridge',
  null,
  'panel.html',
  (panel) => {
    // Panel created
  }
);

// Notify the background script that DevTools is open for this tab
const tabId = chrome.devtools.inspectedWindow.tabId;
chrome.runtime.sendMessage({ action: 'devtoolsOpened', tabId });

// Clean up when DevTools closes
window.addEventListener('beforeunload', () => {
  chrome.runtime.sendMessage({ action: 'devtoolsClosed', tabId });
});
