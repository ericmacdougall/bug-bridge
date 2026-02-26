#!/usr/bin/env node

/**
 * Bug Bridge CLI — Setup tool for the native messaging host.
 *
 * Commands:
 *   init       Register the native messaging host with Chrome
 *   status     Show current environment status
 *   uninstall  Remove the native messaging host registration
 */

'use strict';

const { Command } = require('commander');
const path = require('path');
const register = require('./lib/register');

const program = new Command();

program
  .name('bug-bridge')
  .description('Bug Bridge — Capture debugging context and send to Claude Code')
  .version('0.1.0');

program
  .command('init')
  .description('Register the native messaging host with Chrome')
  .option('--extension-id <id>', 'Chrome extension ID (use * for development)', '*')
  .action((options) => {
    console.log('Setting up Bug Bridge native messaging host...\n');

    const result = register.register(options.extensionId);

    if (!result.success) {
      console.error(`\u2717 Setup failed: ${result.error}`);
      process.exit(1);
    }

    // Show warnings
    for (const warning of result.warnings) {
      console.log(`\u26A0\uFE0F  Warning: ${warning}`);
    }
    if (result.warnings.length > 0) {
      console.log('');
    }

    const status = register.getStatus();

    console.log('\u2713 Bug Bridge native host registered!');
    console.log(`  Manifest: ${result.manifestPath}`);
    console.log(`  Host script: ${result.hostJsPath}`);
    console.log(`  Claude Code: ${status.claudeInPath ? 'found \u2713' : 'not found \u26A0\uFE0F'}`);
    console.log(`  tmux: ${status.tmuxInPath ? 'found \u2713' : 'not found \u26A0\uFE0F'}`);
    console.log('');
    console.log('Next steps:');

    const extensionDir = path.resolve(path.join(__dirname, '..', 'extension'));
    console.log(`  1. Load the Chrome extension from: ${extensionDir}`);
    console.log('  2. Click the Bug Bridge icon and set your repo path for each site');
    console.log('  3. Add .bug-reports/ to your repo\'s .gitignore');
    console.log('  4. Open DevTools on any page to enable full network capture');
    console.log('  5. Click "Report Bug" to capture context and send to Claude Code');
  });

program
  .command('status')
  .description('Show current environment status')
  .action(() => {
    const status = register.getStatus();

    console.log('Bug Bridge — Environment Status');
    console.log('===============================\n');
    console.log(`  OS:                ${status.os}`);
    console.log(`  Node.js:           ${status.nodeVersion}`);
    console.log(`  Native manifest:   ${status.manifestPath}`);
    console.log(`    Exists:          ${status.manifestExists ? '\u2713 yes' : '\u2717 no'}`);
    console.log(`  Host script:       ${status.hostJsPath}`);
    console.log(`    Exists:          ${status.hostJsExists ? '\u2713 yes' : '\u2717 no'}`);
    console.log(`  claude command:    ${status.claudeInPath ? '\u2713 found' : '\u2717 not found'}`);
    console.log(`  tmux command:      ${status.tmuxInPath ? '\u2713 found' : '\u2717 not found'}`);

    if (!status.manifestExists) {
      console.log('\n  Run `bug-bridge init` to register the native host.');
    }
    if (!status.claudeInPath) {
      console.log('\n  Install Claude Code: npm install -g @anthropic-ai/claude-code');
    }
    if (!status.tmuxInPath) {
      console.log('\n  Install tmux: brew install tmux (macOS) or sudo apt install tmux (Linux)');
    }
  });

program
  .command('uninstall')
  .description('Remove the native messaging host registration')
  .action(() => {
    const result = register.unregister();

    if (result.success) {
      console.log('\u2713 Native host unregistered.');
      console.log(`  Removed: ${result.manifestPath}`);
      console.log('\n  You can re-register with `bug-bridge init`.');
    } else {
      console.error(`\u2717 Uninstall failed: ${result.error}`);
      process.exit(1);
    }
  });

program.parse();
