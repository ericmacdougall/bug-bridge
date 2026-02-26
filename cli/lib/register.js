/**
 * Registers/unregisters the native messaging host with Chrome.
 * @module register
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

/**
 * Detects the current operating system.
 * @returns {'macos'|'linux'|'windows'} The detected OS
 */
function detectOS() {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

/**
 * Gets the native messaging host manifest directory for the current OS.
 * @returns {string} Absolute path to the manifest directory
 */
function getManifestDir() {
  const osType = detectOS();
  const home = os.homedir();

  switch (osType) {
    case 'macos':
      return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
    case 'linux':
      return path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts');
    case 'windows':
      return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'BugBridge');
    default:
      return path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts');
  }
}

/**
 * Gets the full path to the native messaging host manifest file.
 * @returns {string} Absolute path to com.bugbridge.host.json
 */
function getManifestPath() {
  return path.join(getManifestDir(), 'com.bugbridge.host.json');
}

/**
 * Resolves the absolute path to host.js.
 * @returns {string} Absolute path to native-host/host.js
 */
function getHostJsPath() {
  return path.resolve(path.join(__dirname, '..', '..', 'native-host', 'host.js'));
}

/**
 * Checks if a command is available in PATH.
 * @param {string} command - The command to check
 * @returns {boolean} True if the command is found
 */
function isCommandInPath(command) {
  try {
    execFileSync('which', [command], { stdio: 'pipe' });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Registers the native messaging host with Chrome.
 * @param {string} [extensionId='*'] - The Chrome extension ID (use '*' for development)
 * @returns {{ success: boolean, manifestPath: string, hostJsPath: string, warnings: string[] }}
 */
function register(extensionId = '*') {
  const warnings = [];
  const manifestDir = getManifestDir();
  const manifestPath = getManifestPath();
  const hostJsPath = getHostJsPath();

  // Verify host.js exists
  if (!fs.existsSync(hostJsPath)) {
    return {
      success: false,
      manifestPath,
      hostJsPath,
      warnings,
      error: `host.js not found at: ${hostJsPath}`
    };
  }

  // Make host.js executable
  try {
    fs.chmodSync(hostJsPath, 0o755);
  } catch (err) {
    warnings.push(`Could not make host.js executable: ${err.message}`);
  }

  // Ensure shebang line
  try {
    const content = fs.readFileSync(hostJsPath, 'utf8');
    if (!content.startsWith('#!/usr/bin/env node')) {
      warnings.push('host.js does not start with #!/usr/bin/env node shebang');
    }
  } catch (err) {
    warnings.push(`Could not read host.js: ${err.message}`);
  }

  // Create manifest directory
  try {
    fs.mkdirSync(manifestDir, { recursive: true });
  } catch (err) {
    return {
      success: false,
      manifestPath,
      hostJsPath,
      warnings,
      error: `Cannot create manifest directory: ${err.message}`
    };
  }

  // Build allowed_origins
  const allowedOrigins = extensionId === '*'
    ? ['chrome-extension://*/']
    : [`chrome-extension://${extensionId}/`];

  // Write manifest
  const manifest = {
    name: 'com.bugbridge.host',
    description: 'Bug Bridge native messaging host for Claude Code integration',
    path: hostJsPath,
    type: 'stdio',
    allowed_origins: allowedOrigins
  };

  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  } catch (err) {
    return {
      success: false,
      manifestPath,
      hostJsPath,
      warnings,
      error: `Cannot write manifest: ${err.message}`
    };
  }

  // Windows: also write registry key
  if (detectOS() === 'windows') {
    try {
      const regCmd = `reg add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.bugbridge.host" /ve /t REG_SZ /d "${manifestPath}" /f`;
      execFileSync('cmd', ['/c', regCmd], { stdio: 'pipe' });
    } catch (err) {
      warnings.push(`Could not write Windows registry key: ${err.message}`);
    }
  }

  // Check for claude command
  if (!isCommandInPath('claude')) {
    warnings.push("'claude' command not found in PATH. Install Claude Code: npm install -g @anthropic-ai/claude-code");
  }

  // Check for tmux command
  if (!isCommandInPath('tmux')) {
    warnings.push("'tmux' not found. Bug Bridge needs tmux to run Claude Code in the background. Install with: brew install tmux (macOS) or sudo apt install tmux (Linux)");
  }

  return {
    success: true,
    manifestPath,
    hostJsPath,
    warnings
  };
}

/**
 * Removes the native messaging host registration.
 * @returns {{ success: boolean, manifestPath: string }}
 */
function unregister() {
  const manifestPath = getManifestPath();

  try {
    if (fs.existsSync(manifestPath)) {
      fs.unlinkSync(manifestPath);
    }
  } catch (err) {
    return {
      success: false,
      manifestPath,
      error: `Cannot remove manifest: ${err.message}`
    };
  }

  // Windows: remove registry key
  if (detectOS() === 'windows') {
    try {
      execFileSync('cmd', ['/c', 'reg delete "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.bugbridge.host" /f'], { stdio: 'pipe' });
    } catch (err) {
      // Ignore — key might not exist
    }
  }

  return {
    success: true,
    manifestPath
  };
}

/**
 * Gets the current status of the native messaging host installation.
 * @returns {object} Status information
 */
function getStatus() {
  const manifestPath = getManifestPath();
  const hostJsPath = getHostJsPath();
  const osType = detectOS();

  return {
    os: osType,
    nodeVersion: process.version,
    manifestPath,
    manifestExists: fs.existsSync(manifestPath),
    hostJsPath,
    hostJsExists: fs.existsSync(hostJsPath),
    claudeInPath: isCommandInPath('claude'),
    tmuxInPath: isCommandInPath('tmux')
  };
}

module.exports = {
  register,
  unregister,
  getStatus,
  getManifestPath,
  getHostJsPath,
  detectOS,
  isCommandInPath
};
