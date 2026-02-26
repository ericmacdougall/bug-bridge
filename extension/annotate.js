/**
 * Annotation overlay for Bug Bridge.
 * Injected into pages when the user clicks "Report Bug".
 * Provides drawing tools (freehand, rectangle, arrow) and a description input.
 */

(() => {
  'use strict';

  // Expose the annotation function globally so the background script can invoke it
  window.__bugBridgeAnnotate = function (screenshotDataUrl) {
    createAnnotationOverlay(screenshotDataUrl);
  };

  /**
   * Creates and shows the annotation overlay.
   * @param {string|null} screenshotDataUrl - The raw screenshot data URL
   */
  function createAnnotationOverlay(screenshotDataUrl) {
    // Remove any existing overlay
    const existing = document.getElementById('bug-bridge-overlay');
    if (existing) existing.remove();

    // State
    let currentTool = 'draw'; // 'draw' | 'rect' | 'arrow'
    let currentColor = '#ef4444'; // red default
    let currentWidth = 4; // medium
    let isDrawing = false;
    let startX = 0;
    let startY = 0;

    // Drawing history for undo
    const history = [];
    let currentPath = [];

    // Create overlay container
    const overlay = document.createElement('div');
    overlay.id = 'bug-bridge-overlay';

    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.id = 'bug-bridge-canvas';
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d');

    // Create toolbar
    const toolbar = document.createElement('div');
    toolbar.id = 'bug-bridge-toolbar';

    // Colors
    const colors = [
      { value: '#ef4444', name: 'Red' },
      { value: '#eab308', name: 'Yellow' },
      { value: '#3b82f6', name: 'Blue' },
      { value: '#22c55e', name: 'Green' },
      { value: '#ffffff', name: 'White' },
      { value: '#000000', name: 'Black' }
    ];

    colors.forEach((color) => {
      const btn = document.createElement('div');
      btn.className = `color-btn ${color.value === currentColor ? 'active' : ''}`;
      btn.style.background = color.value;
      if (color.value === '#000000') {
        btn.style.border = '2px solid #555';
      }
      btn.title = color.name;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        currentColor = color.value;
        toolbar.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      toolbar.appendChild(btn);
    });

    // Separator
    toolbar.appendChild(createSeparator());

    // Tools
    const tools = [
      { id: 'draw', label: 'Draw' },
      { id: 'rect', label: 'Rect' },
      { id: 'arrow', label: 'Arrow' }
    ];

    tools.forEach((tool) => {
      const btn = document.createElement('button');
      btn.className = `tool-btn ${tool.id === currentTool ? 'active' : ''}`;
      btn.textContent = tool.label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        currentTool = tool.id;
        toolbar.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      toolbar.appendChild(btn);
    });

    // Separator
    toolbar.appendChild(createSeparator());

    // Line widths
    const widths = [
      { value: 2, label: 'Thin' },
      { value: 4, label: 'Med' },
      { value: 8, label: 'Thick' }
    ];

    widths.forEach((w) => {
      const btn = document.createElement('button');
      btn.className = `width-btn ${w.value === currentWidth ? 'active' : ''}`;
      btn.textContent = w.label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        currentWidth = w.value;
        toolbar.querySelectorAll('.width-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      toolbar.appendChild(btn);
    });

    // Separator
    toolbar.appendChild(createSeparator());

    // Action buttons
    const undoBtn = createActionBtn('Undo', 'btn-undo action-btn', () => {
      if (history.length > 0) {
        history.pop();
        redrawCanvas();
      }
    });
    toolbar.appendChild(undoBtn);

    const clearBtn = createActionBtn('Clear', 'btn-clear-drawing action-btn', () => {
      history.length = 0;
      redrawCanvas();
    });
    toolbar.appendChild(clearBtn);

    // Separator
    toolbar.appendChild(createSeparator());

    const doneBtn = createActionBtn('Done', 'btn-done action-btn', () => {
      finalize(false);
    });
    toolbar.appendChild(doneBtn);

    const cancelBtn = createActionBtn('Cancel', 'btn-cancel action-btn', () => {
      finalize(true);
    });
    toolbar.appendChild(cancelBtn);

    // Description bar
    const descBar = document.createElement('div');
    descBar.id = 'bug-bridge-description-bar';

    const textarea = document.createElement('textarea');
    textarea.placeholder = "Describe the bug you're seeing...";
    textarea.rows = 3;
    descBar.appendChild(textarea);

    // Inject styles
    const style = document.createElement('style');
    style.textContent = getAnnotateCSS();

    // Assemble
    overlay.appendChild(style);
    overlay.appendChild(canvas);
    overlay.appendChild(toolbar);
    overlay.appendChild(descBar);
    document.body.appendChild(overlay);

    // ============================================================
    // Drawing logic
    // ============================================================

    canvas.addEventListener('pointerdown', (e) => {
      if (e.target !== canvas) return;
      isDrawing = true;
      startX = e.clientX;
      startY = e.clientY;

      if (currentTool === 'draw') {
        currentPath = [{ x: e.clientX, y: e.clientY }];
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!isDrawing) return;

      if (currentTool === 'draw') {
        currentPath.push({ x: e.clientX, y: e.clientY });
        redrawCanvas();
        // Draw current path
        drawFreehand(ctx, currentPath, currentColor, currentWidth);
      } else if (currentTool === 'rect') {
        redrawCanvas();
        drawRect(ctx, startX, startY, e.clientX, e.clientY, currentColor, currentWidth);
      } else if (currentTool === 'arrow') {
        redrawCanvas();
        drawArrow(ctx, startX, startY, e.clientX, e.clientY, currentColor, currentWidth);
      }
    });

    canvas.addEventListener('pointerup', (e) => {
      if (!isDrawing) return;
      isDrawing = false;

      if (currentTool === 'draw') {
        currentPath.push({ x: e.clientX, y: e.clientY });
        history.push({ type: 'draw', path: [...currentPath], color: currentColor, width: currentWidth });
        currentPath = [];
      } else if (currentTool === 'rect') {
        history.push({ type: 'rect', x1: startX, y1: startY, x2: e.clientX, y2: e.clientY, color: currentColor, width: currentWidth });
      } else if (currentTool === 'arrow') {
        history.push({ type: 'arrow', x1: startX, y1: startY, x2: e.clientX, y2: e.clientY, color: currentColor, width: currentWidth });
      }

      redrawCanvas();
    });

    // Prevent text selection while drawing
    canvas.addEventListener('selectstart', (e) => e.preventDefault());

    // Keyboard shortcuts
    function annotateKeyHandler(e) {
      if (e.key === 'Escape') {
        finalize(true);
      }
      if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (history.length > 0) {
          history.pop();
          redrawCanvas();
        }
      }
    }
    document.addEventListener('keydown', annotateKeyHandler);

    // ============================================================
    // Drawing functions
    // ============================================================

    function redrawCanvas() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      history.forEach((item) => {
        if (item.type === 'draw') {
          drawFreehand(ctx, item.path, item.color, item.width);
        } else if (item.type === 'rect') {
          drawRect(ctx, item.x1, item.y1, item.x2, item.y2, item.color, item.width);
        } else if (item.type === 'arrow') {
          drawArrow(ctx, item.x1, item.y1, item.x2, item.y2, item.color, item.width);
        }
      });
    }

    function drawFreehand(ctx, path, color, width) {
      if (path.length < 2) return;
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x, path[i].y);
      }
      ctx.stroke();
    }

    function drawRect(ctx, x1, y1, x2, y2, color, width) {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'miter';
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }

    function drawArrow(ctx, x1, y1, x2, y2, color, width) {
      const headLength = Math.max(width * 4, 16);
      const angle = Math.atan2(y2 - y1, x2 - x1);

      // Line
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      // Arrowhead
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.moveTo(x2, y2);
      ctx.lineTo(
        x2 - headLength * Math.cos(angle - Math.PI / 6),
        y2 - headLength * Math.sin(angle - Math.PI / 6)
      );
      ctx.lineTo(
        x2 - headLength * Math.cos(angle + Math.PI / 6),
        y2 - headLength * Math.sin(angle + Math.PI / 6)
      );
      ctx.closePath();
      ctx.fill();
    }

    // ============================================================
    // Finalize
    // ============================================================

    function finalize(cancelled) {
      document.removeEventListener('keydown', annotateKeyHandler);

      if (cancelled) {
        overlay.remove();
        chrome.runtime.sendMessage({ action: 'annotationCancelled' });
        return;
      }

      const description = textarea.value.trim();

      // Composite annotated screenshot
      let annotatedScreenshot = null;

      if (screenshotDataUrl && history.length > 0) {
        // Create offscreen canvas, draw screenshot + annotations
        const offscreen = document.createElement('canvas');
        const img = new Image();
        img.onload = () => {
          offscreen.width = img.width;
          offscreen.height = img.height;
          const offCtx = offscreen.getContext('2d');

          // Draw screenshot
          offCtx.drawImage(img, 0, 0);

          // Scale factor: the annotation canvas is viewport-sized,
          // but the screenshot may be a different resolution (devicePixelRatio)
          const scaleX = img.width / canvas.width;
          const scaleY = img.height / canvas.height;

          // Redraw all annotations at the correct scale
          offCtx.save();
          offCtx.scale(scaleX, scaleY);
          history.forEach((item) => {
            if (item.type === 'draw') {
              drawFreehand(offCtx, item.path, item.color, item.width);
            } else if (item.type === 'rect') {
              drawRect(offCtx, item.x1, item.y1, item.x2, item.y2, item.color, item.width);
            } else if (item.type === 'arrow') {
              drawArrow(offCtx, item.x1, item.y1, item.x2, item.y2, item.color, item.width);
            }
          });
          offCtx.restore();

          annotatedScreenshot = offscreen.toDataURL('image/png');
          overlay.remove();
          chrome.runtime.sendMessage({
            action: 'annotationComplete',
            annotatedScreenshot,
            description
          });
        };
        img.onerror = () => {
          overlay.remove();
          chrome.runtime.sendMessage({
            action: 'annotationComplete',
            annotatedScreenshot: null,
            description
          });
        };
        img.src = screenshotDataUrl;
      } else {
        overlay.remove();
        chrome.runtime.sendMessage({
          action: 'annotationComplete',
          annotatedScreenshot: null,
          description
        });
      }
    }

    // ============================================================
    // Helpers
    // ============================================================

    function createSeparator() {
      const sep = document.createElement('div');
      sep.className = 'separator';
      return sep;
    }

    function createActionBtn(label, className, handler) {
      const btn = document.createElement('button');
      btn.className = className;
      btn.textContent = label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handler();
      });
      return btn;
    }
  }

  /**
   * Returns the annotation CSS as a string (for injection).
   * @returns {string}
   */
  function getAnnotateCSS() {
    return `
      #bug-bridge-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      #bug-bridge-toolbar {
        position: fixed;
        top: 10px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        background: rgba(0, 0, 0, 0.85);
        color: #fff;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 10px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        font-size: 12px;
        user-select: none;
      }
      #bug-bridge-toolbar .separator {
        width: 1px;
        height: 20px;
        background: rgba(255, 255, 255, 0.2);
      }
      #bug-bridge-toolbar .color-btn {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
        transition: border-color 0.2s;
      }
      #bug-bridge-toolbar .color-btn:hover,
      #bug-bridge-toolbar .color-btn.active {
        border-color: #fff;
      }
      #bug-bridge-toolbar .tool-btn,
      #bug-bridge-toolbar .width-btn {
        padding: 5px 10px;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 5px;
        color: #fff;
        cursor: pointer;
        font-size: 12px;
        transition: background 0.2s;
      }
      #bug-bridge-toolbar .tool-btn:hover,
      #bug-bridge-toolbar .width-btn:hover {
        background: rgba(255, 255, 255, 0.2);
      }
      #bug-bridge-toolbar .tool-btn.active,
      #bug-bridge-toolbar .width-btn.active {
        background: #4f46e5;
        border-color: #4f46e5;
      }
      #bug-bridge-toolbar .action-btn {
        padding: 5px 12px;
        border: none;
        border-radius: 5px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
        transition: background 0.2s;
      }
      #bug-bridge-toolbar .btn-undo,
      #bug-bridge-toolbar .btn-clear-drawing {
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
      }
      #bug-bridge-toolbar .btn-undo:hover,
      #bug-bridge-toolbar .btn-clear-drawing:hover {
        background: rgba(255, 255, 255, 0.25);
      }
      #bug-bridge-toolbar .btn-done {
        background: #22c55e;
        color: #000;
      }
      #bug-bridge-toolbar .btn-done:hover {
        background: #16a34a;
      }
      #bug-bridge-toolbar .btn-cancel {
        background: #ef4444;
        color: #fff;
      }
      #bug-bridge-toolbar .btn-cancel:hover {
        background: #dc2626;
      }
      #bug-bridge-canvas {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        z-index: 2147483646;
        cursor: crosshair;
      }
      #bug-bridge-description-bar {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        z-index: 2147483647;
        background: rgba(0, 0, 0, 0.9);
        padding: 10px 16px;
        display: flex;
        align-items: flex-start;
        gap: 10px;
      }
      #bug-bridge-description-bar textarea {
        flex: 1;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 6px;
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        padding: 8px 12px;
        min-height: 60px;
        max-height: 200px;
        resize: vertical;
        outline: none;
        line-height: 1.4;
      }
      #bug-bridge-description-bar textarea::placeholder {
        color: rgba(255, 255, 255, 0.4);
      }
      #bug-bridge-description-bar textarea:focus {
        border-color: #4f46e5;
      }
    `;
  }
})();
