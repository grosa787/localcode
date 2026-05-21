#!/usr/bin/env node
// LocalCode npm shim launcher.
// Spawns the platform-specific native binary placed in vendor/ by the postinstall script.
// Why a launcher (and not a bin symlink to vendor/...): npm rewrites file modes on Windows
// and some sandboxed installers (pnpm offline, yarn pnp) — using a Node entrypoint sidesteps
// permission and shebang issues consistently.

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PKG_ROOT = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(PKG_ROOT, 'vendor');

function resolveBinaryPath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(VENDOR_DIR, `localcode${ext}`);
}

function fail(message) {
  process.stderr.write(`localcode: ${message}\n`);
  process.exit(1);
}

function main() {
  const binPath = resolveBinaryPath();
  if (!fs.existsSync(binPath)) {
    fail(
      `native binary not found at ${binPath}\n` +
        `  Try reinstalling: npm install -g @grosa787/localcode\n` +
        `  Or set LOCALCODE_BINARY_URL to a custom asset URL and reinstall.`,
    );
  }

  try {
    fs.accessSync(binPath, fs.constants.X_OK);
  } catch {
    try {
      fs.chmodSync(binPath, 0o755);
    } catch (err) {
      fail(`binary is not executable and chmod failed: ${err && err.message ? err.message : err}`);
    }
  }

  const child = spawn(binPath, process.argv.slice(2), {
    stdio: 'inherit',
    windowsHide: false,
  });

  child.on('error', (err) => {
    fail(`failed to launch binary: ${err && err.message ? err.message : err}`);
  });

  // Forward common signals so Ctrl-C and parent-driven kills propagate.
  const forwardSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const sig of forwardSignals) {
    process.on(sig, () => {
      if (!child.killed) {
        try {
          child.kill(sig);
        } catch {
          // ignore — child may have already exited
        }
      }
    });
  }

  child.on('exit', (code, signal) => {
    if (signal) {
      // Re-raise the signal on ourselves so callers see the expected exit semantics.
      process.kill(process.pid, signal);
      return;
    }
    process.exit(typeof code === 'number' ? code : 0);
  });
}

main();
