# Bug Bridge

Capture full debugging context from a live website in Chrome and route it to Claude Code for automated bug fixing.

Bug Bridge is a Chrome extension + local Node.js native messaging host. You browse your site, hit "Report Bug", annotate the problem, and Claude Code receives the full context (screenshot, console errors, network logs, cookies, page source) and starts fixing it automatically.

## How it works

1. **You browse your site** in Chrome with the Bug Bridge extension installed
2. **Click "Report Bug"** from the popup or DevTools panel
3. **Annotate the problem** — draw on the page, type a description
4. **Bug Bridge captures everything** — screenshot, console errors, network HAR, cookies, page source, metadata
5. **Files are written** to your repo's `.bug-reports/` directory
6. **Claude Code starts** in a tmux session and begins diagnosing the bug
7. **Watch or steer** Claude Code by attaching to the tmux session

## Setup

### Prerequisites

- Node.js >= 18
- Chrome browser
- [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code) (`npm install -g @anthropic-ai/claude-code`)
- [tmux](https://github.com/tmux/tmux) (`brew install tmux` on macOS, `sudo apt install tmux` on Linux)

### 1. Install and register the native host

```bash
# Clone the repo
git clone https://github.com/ericmacdougall/bug-bridge.git
cd bug-bridge

# Install dependencies
npm install

# Register the native messaging host with Chrome
node cli/index.js init
```

### 2. Load the Chrome extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top-right)
3. Click "Load unpacked"
4. Select the `extension/` directory from this repo

### 3. Configure repo mappings

1. Navigate to your website (e.g., `http://localhost:3000`)
2. Click the Bug Bridge icon in Chrome's toolbar
3. Enter the absolute path to your repo (e.g., `/Users/me/projects/my-app`)
4. Click "Save"

Each hostname gets its own mapping. You can map multiple hostnames to the same repo (e.g., `localhost:3000` and `staging.myapp.com` both pointing to the same project).

## Reporting a bug

1. **Open the Bug Bridge popup** and click "Report Bug", or use the button in the DevTools panel
2. **Annotate the screenshot** — use freehand drawing, rectangles, or arrows to highlight the problem area
3. **Describe the bug** in the text area at the bottom
4. **Click "Done"** to submit

Bug Bridge captures:
- Screenshot (raw + annotated)
- Console errors and warnings
- Full network HAR log (requires DevTools to be open)
- Network errors (failed requests)
- All cookies for the domain
- Full page HTML source
- Browser metadata (viewport, user agent, screen resolution)

## Watching Claude Code work

After submitting a bug report, Bug Bridge starts Claude Code in a tmux session. To watch:

```bash
# The tmux session is named after your repo
tmux attach -t bug-bridge-my-app
```

The popup and DevTools panel also show an "Open Terminal" button that copies this command to your clipboard.

Inside the tmux session you can:
- **Watch** Claude Code diagnose and fix the bug
- **Type** to steer Claude Code if needed
- **Detach** with `Ctrl+B, D` to let it work in the background

## How the queue works

Bug reports are processed one at a time per repo in FIFO order:

- Submit multiple bugs rapidly — they queue up as #1, #2, #3
- The daemon processes them in order with a 5-second countdown between reports
- During the countdown:
  - **Ctrl+C** skips the next report
  - **q** pauses the queue (press **r** to resume)
- The queue file is at `{repo}/.bug-reports/queue.json`

## Multiple repos

Each repo gets its own independent:
- Bug report directory (`.bug-reports/`)
- Queue file (`queue.json`)
- Daemon process
- tmux session (named `bug-bridge-{repo-name}`)

Map `localhost:3000` to repo A and `localhost:8080` to repo B, and each runs its own Claude Code instance.

## CLI commands

```bash
# Register native messaging host with Chrome
bug-bridge init

# Check environment status
bug-bridge status

# Remove native messaging host registration
bug-bridge uninstall
```

## Project structure

```
bug-bridge/
  extension/           # Chrome extension (Manifest V3)
    manifest.json
    background.js      # Service worker
    content.js         # Console error capture
    popup.*            # Popup UI for repo mapping
    panel.*            # DevTools panel UI
    devtools.*         # DevTools page
    annotate.js        # Annotation overlay (injected programmatically)
    lib/
      repo-mapper.js   # Hostname-to-repo mapping
      har-collector.js # HAR format collector
      messaging.js     # Native messaging wrapper
      capture.js       # Capture orchestrator
      storage-keys.js  # Storage constants
    icons/
  native-host/         # Native messaging host
    host.js            # Short-lived message handler
    daemon.js          # Long-running Claude Code runner
    lib/
      protocol.js      # Native messaging protocol
      file-writer.js   # Bundle file writer
      prompt-generator.js
      queue.js         # File-based report queue
      daemon-client.js # Daemon lifecycle management
      terminal.js      # tmux utilities
  cli/                 # Setup CLI
    index.js
    lib/
      register.js      # Chrome registration
```

## File output

Each bug report creates a timestamped directory:

```
{repo}/.bug-reports/2026-02-25-143022/
  screenshot-raw.png
  screenshot-annotated.png
  description.txt
  console-errors.json
  network-full.har
  network-errors.json
  cookies.json
  page-source.html
  meta.json
  prompt.md
  manifest.json
```

## Troubleshooting

**"Native host not found"** — Run `node cli/index.js init` to register the native host with Chrome.

**"tmux not found"** — Install tmux: `brew install tmux` (macOS) or `sudo apt install tmux` (Linux).

**"claude command not found"** — Install Claude Code: `npm install -g @anthropic-ai/claude-code`.

**No network logs in report** — Open Chrome DevTools (F12) before clicking "Report Bug". The HAR capture requires the DevTools panel to be active.

**Queue stuck** — Check `.bug-reports/queue.json`. You can manually edit the status of entries or delete the file to reset.
