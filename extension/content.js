/**
 * Content script injected into every page.
 * Captures console errors, warnings, and unhandled exceptions.
 * Sends captured errors to the background script.
 */

(() => {
  'use strict';

  const MAX_ENTRIES = 500;
  const BATCH_INTERVAL = 5000; // 5 seconds

  /** @type {Array<object>} Captured error/warning entries (ring buffer, max MAX_ENTRIES) */
  const capturedErrors = [];

  /** @type {Array<object>} Errors not yet sent to background script */
  const unsentErrors = [];

  /**
   * Adds an entry to the captured errors array and the unsent queue.
   * @param {object} entry - The error entry to add
   */
  function addEntry(entry) {
    capturedErrors.push(entry);
    if (capturedErrors.length > MAX_ENTRIES) {
      capturedErrors.shift(); // FIFO eviction
    }
    unsentErrors.push(entry);
  }

  // Override console.error
  const originalConsoleError = console.error;
  console.error = function (...args) {
    try {
      const message = args.map(a => {
        try {
          return typeof a === 'object' ? JSON.stringify(a) : String(a);
        } catch (e) {
          return String(a);
        }
      }).join(' ');

      addEntry({
        level: 'error',
        message,
        stack: (new Error()).stack || null,
        timestamp: new Date().toISOString(),
        source: null,
        line: null,
        column: null
      });
    } catch (e) {
      // Silently fail — don't break the page
    }
    return originalConsoleError.apply(console, args);
  };

  // Override console.warn
  const originalConsoleWarn = console.warn;
  console.warn = function (...args) {
    try {
      const message = args.map(a => {
        try {
          return typeof a === 'object' ? JSON.stringify(a) : String(a);
        } catch (e) {
          return String(a);
        }
      }).join(' ');

      addEntry({
        level: 'warn',
        message,
        stack: null,
        timestamp: new Date().toISOString(),
        source: null,
        line: null,
        column: null
      });
    } catch (e) {
      // Silently fail
    }
    return originalConsoleWarn.apply(console, args);
  };

  // window.onerror
  const originalOnError = window.onerror;
  window.onerror = function (message, source, line, column, error) {
    try {
      addEntry({
        level: 'unhandled_exception',
        message: String(message),
        stack: error && error.stack ? error.stack : null,
        timestamp: new Date().toISOString(),
        source: source || null,
        line: line || null,
        column: column || null
      });
    } catch (e) {
      // Silently fail
    }
    if (originalOnError) {
      return originalOnError.apply(window, arguments);
    }
    return false;
  };

  // window.onunhandledrejection
  window.addEventListener('unhandledrejection', (event) => {
    try {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      const stack = reason instanceof Error ? reason.stack : null;

      addEntry({
        level: 'unhandled_rejection',
        message,
        stack,
        timestamp: new Date().toISOString(),
        source: null,
        line: null,
        column: null
      });
    } catch (e) {
      // Silently fail
    }
  });

  // Listen for messages from background/popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getConsoleErrors') {
      sendResponse({ errors: [...capturedErrors] });
      return true;
    }

    if (message.action === 'getPageInfo') {
      sendResponse({
        viewport: { width: window.innerWidth, height: window.innerHeight },
        userAgent: navigator.userAgent,
        screenResolution: { width: screen.width, height: screen.height },
        devicePixelRatio: window.devicePixelRatio
      });
      return true;
    }

    if (message.action === 'showToast') {
      showToast(message.text, message.subtext, message.clipboardText, message.duration);
      sendResponse({ success: true });
      return true;
    }
  });

  // Batch send new errors to background every 5 seconds
  setInterval(() => {
    if (unsentErrors.length > 0) {
      const batch = unsentErrors.splice(0);
      try {
        chrome.runtime.sendMessage({
          action: 'consoleErrorsBatch',
          errors: batch,
          tabUrl: window.location.href
        });
      } catch (e) {
        // Extension context may be invalidated
      }
    }
  }, BATCH_INTERVAL);

  /**
   * Shows a toast notification on the page.
   * @param {string} text - Main text
   * @param {string} [subtext] - Secondary text
   * @param {string} [clipboardText] - Text to copy on click
   * @param {number} [duration=5000] - Auto-dismiss duration in ms
   */
  function showToast(text, subtext, clipboardText, duration = 5000) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: rgba(0, 0, 0, 0.9);
      color: #fff;
      padding: 16px 20px;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.4;
      max-width: 400px;
      z-index: 2147483647;
      cursor: ${clipboardText ? 'pointer' : 'default'};
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      transition: opacity 0.3s ease, transform 0.3s ease;
      transform: translateY(-10px);
      opacity: 0;
      border-left: 3px solid #22c55e;
    `;

    const mainText = document.createElement('div');
    mainText.textContent = text;
    mainText.style.fontWeight = '600';
    toast.appendChild(mainText);

    if (subtext) {
      const sub = document.createElement('div');
      sub.textContent = subtext;
      sub.style.cssText = 'font-size: 12px; opacity: 0.8; margin-top: 4px;';
      toast.appendChild(sub);
    }

    if (clipboardText) {
      const hint = document.createElement('div');
      hint.textContent = 'Click to copy command';
      hint.style.cssText = 'font-size: 11px; opacity: 0.5; margin-top: 6px;';
      toast.appendChild(hint);

      toast.addEventListener('click', () => {
        navigator.clipboard.writeText(clipboardText).then(() => {
          mainText.textContent = 'Copied to clipboard!';
          setTimeout(() => removeToast(), 1000);
        });
      });
    }

    document.body.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    });

    function removeToast() {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    }

    // Auto-dismiss
    setTimeout(removeToast, duration);
  }
})();
