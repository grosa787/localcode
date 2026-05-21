/**
 * Native folder-picker spawn helpers.
 *
 * LocalCode runs as a CLI on the user's machine, so the backend can
 * shell out to the platform's native folder-chooser dialog. The
 * browser-side caller just receives the absolute path.
 *
 *   - macOS  -> `osascript -e 'POSIX path of (choose folder ...)'`
 *   - Linux  -> `zenity --file-selection --directory` then `kdialog ...`
 *   - win32  -> PowerShell + System.Windows.Forms.FolderBrowserDialog
 *
 * Cancellation surfaces as `{ cancelled: true, path: null }`. Unsupported
 * platforms return `{ platform: 'unsupported', path: null, cancelled: false }`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { platform as osPlatform } from 'node:os';

/**
 * M6 — AppleScript escape. Backslash + double-quote handle the obvious
 * string literal break. We ALSO escape parens and ampersand because
 * AppleScript supports inline expression continuation across these
 * (e.g. `"a") & (do shell script "id"`). Even with `&` escaped, the
 * stdin-pipe approach below is the primary defense — argv `-e` is no
 * longer used in the safe path.
 */
function escapeAppleScriptString(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

export type PickFolderPlatform = 'darwin' | 'linux' | 'win32' | 'unsupported';

export interface PickFolderResult {
  /** Absolute path the user picked, or null when cancelled / unsupported. */
  path: string | null;
  cancelled: boolean;
  platform: PickFolderPlatform;
}

export interface PickFolderOptions {
  /** Window title shown by the OS dialog. Sanitised before use. */
  prompt?: string;
}

/** 5 minute soft cap on the dialog being open. */
const PICK_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULT_PROMPT = 'Select project folder';

/** Strip control chars so prompts can't break out of argv. Stays printable-ASCII friendly. */
function sanitisePrompt(input: string | undefined): string {
  if (input === undefined) return DEFAULT_PROMPT;
  let out = '';
  for (let i = 0; i < input.length && out.length < 200; i++) {
    const ch = input.charCodeAt(i);
    // Drop C0 controls (0-31) and DEL (127); replace with space.
    if (ch < 32 || ch === 127) {
      if (out.length > 0 && out[out.length - 1] !== ' ') out += ' ';
      continue;
    }
    out += input[i];
  }
  const trimmed = out.trim();
  if (trimmed.length === 0) return DEFAULT_PROMPT;
  return trimmed;
}

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Spawn helper. When `stdinInput` is provided we open a stdin pipe and
 * write the payload — this is how M6 keeps untrusted text out of argv
 * (osascript reads the script from stdin when invoked without `-e`).
 * When omitted, stdin is inherited as `'ignore'` so the child can't
 * block on a pty.
 */
function runSpawn(
  cmd: string,
  args: readonly string[],
  timeoutMs: number = PICK_TIMEOUT_MS,
  stdinInput?: string,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    const stdinMode = stdinInput !== undefined ? 'pipe' : 'ignore';
    try {
      child = spawn(cmd, args, { stdio: [stdinMode, 'pipe', 'pipe'] });
    } catch (err) {
      resolve({
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        code: -1,
        timedOut: false,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // process may already be gone
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + (err instanceof Error ? err.message : String(err)),
        code: -1,
        timedOut,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });

    if (stdinInput !== undefined && child.stdin) {
      child.stdin.end(stdinInput);
    }
  });
}

/**
 * Test seam: override the spawn runner to mock OS interactions.
 *
 * The runner signature accepts an optional `stdinInput` so tests can
 * assert the script is delivered through stdin rather than `-e`. Existing
 * tests that only inspect `cmd`/`args` continue to work — the extra arg
 * is positional and ignored when unused.
 */
export interface PickFolderInternals {
  runner?: (
    cmd: string,
    args: readonly string[],
    stdinInput?: string,
  ) => Promise<SpawnOutcome>;
  which?: (cmd: string) => Promise<boolean>;
  platformOverride?: PickFolderPlatform;
}

async function whichExists(cmd: string): Promise<boolean> {
  const outcome = await runSpawn('/usr/bin/env', ['which', cmd], 5_000, undefined);
  return outcome.code === 0 && outcome.stdout.trim().length > 0;
}

function detectPlatform(): PickFolderPlatform {
  const p = osPlatform();
  if (p === 'darwin') return 'darwin';
  if (p === 'linux') return 'linux';
  if (p === 'win32') return 'win32';
  return 'unsupported';
}

function trimTrailingNewlines(s: string): string {
  let end = s.length;
  while (end > 0) {
    const ch = s.charCodeAt(end - 1);
    if (ch === 10 || ch === 13) {
      end -= 1;
      continue;
    }
    break;
  }
  return s.slice(0, end);
}

async function pickDarwin(
  prompt: string,
  runner: (
    cmd: string,
    args: readonly string[],
    stdinInput?: string,
  ) => Promise<SpawnOutcome>,
): Promise<PickFolderResult> {
  // M6 — Deliver the AppleScript via STDIN, not via `-e`. This means
  // even if our escaping is incomplete or someone reintroduces an
  // injection vector in the prompt, osascript will only ever see the
  // literal script text — it cannot be split into multiple statements
  // by argv parsing. Also belt-and-braces: we still escape `\` and `"`
  // inside the string literal so the script itself parses cleanly.
  const escaped = escapeAppleScriptString(prompt);
  const script = `POSIX path of (choose folder with prompt "${escaped}")\n`;
  // Empty argv → osascript reads the script from stdin.
  const outcome = await runner('osascript', [], script);
  if (outcome.timedOut) {
    return { path: null, cancelled: true, platform: 'darwin' };
  }
  const trimmed = trimTrailingNewlines(outcome.stdout);
  if (outcome.code === 0 && trimmed.length > 0) {
    return { path: trimmed, cancelled: false, platform: 'darwin' };
  }
  // osascript exits non-zero on user cancel; treat any empty/non-zero as cancel.
  return { path: null, cancelled: true, platform: 'darwin' };
}

async function pickLinux(
  prompt: string,
  runner: (
    cmd: string,
    args: readonly string[],
    stdinInput?: string,
  ) => Promise<SpawnOutcome>,
  which: (cmd: string) => Promise<boolean>,
): Promise<PickFolderResult> {
  if (await which('zenity')) {
    const outcome = await runner('zenity', [
      '--file-selection',
      '--directory',
      `--title=${prompt}`,
    ]);
    if (outcome.timedOut) {
      return { path: null, cancelled: true, platform: 'linux' };
    }
    const trimmed = trimTrailingNewlines(outcome.stdout);
    if (outcome.code === 0 && trimmed.length > 0) {
      return { path: trimmed, cancelled: false, platform: 'linux' };
    }
    return { path: null, cancelled: true, platform: 'linux' };
  }
  if (await which('kdialog')) {
    const home = process.env['HOME'] ?? '/';
    const outcome = await runner('kdialog', [
      '--getexistingdirectory',
      home,
      '--title',
      prompt,
    ]);
    if (outcome.timedOut) {
      return { path: null, cancelled: true, platform: 'linux' };
    }
    const trimmed = trimTrailingNewlines(outcome.stdout);
    if (outcome.code === 0 && trimmed.length > 0) {
      return { path: trimmed, cancelled: false, platform: 'linux' };
    }
    return { path: null, cancelled: true, platform: 'linux' };
  }
  return { path: null, cancelled: false, platform: 'unsupported' };
}

async function pickWin32(
  prompt: string,
  runner: (
    cmd: string,
    args: readonly string[],
    stdinInput?: string,
  ) => Promise<SpawnOutcome>,
): Promise<PickFolderResult> {
  // Single-quote the prompt for PowerShell; collapse any embedded ' to ''.
  const psPrompt = prompt.replace(/'/g, "''");
  const script =
    `Add-Type -AssemblyName System.Windows.Forms; ` +
    `$d = New-Object System.Windows.Forms.FolderBrowserDialog; ` +
    `$d.Description = '${psPrompt}'; ` +
    `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ` +
    `Write-Output $d.SelectedPath } else { exit 1 }`;
  const outcome = await runner('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ]);
  if (outcome.timedOut) {
    return { path: null, cancelled: true, platform: 'win32' };
  }
  const trimmed = trimTrailingNewlines(outcome.stdout);
  if (outcome.code === 0 && trimmed.length > 0) {
    return { path: trimmed, cancelled: false, platform: 'win32' };
  }
  return { path: null, cancelled: true, platform: 'win32' };
}

/**
 * Open the native folder-picker for the host OS and block until the
 * user picks or cancels. Never throws — failures collapse into either a
 * cancellation or an `unsupported` result.
 */
export async function pickFolderNative(
  opts: PickFolderOptions = {},
  internals: PickFolderInternals = {},
): Promise<PickFolderResult> {
  const prompt = sanitisePrompt(opts.prompt);
  // Default runner threads the configured timeout AND optional stdin
  // through to `runSpawn`. Test-supplied runners may omit the timeout
  // argument; we use the canonical PICK_TIMEOUT_MS.
  const runner: (
    cmd: string,
    args: readonly string[],
    stdinInput?: string,
  ) => Promise<SpawnOutcome> =
    internals.runner ??
    ((cmd, args, stdinInput) => runSpawn(cmd, args, PICK_TIMEOUT_MS, stdinInput));
  const which = internals.which ?? whichExists;
  const platform = internals.platformOverride ?? detectPlatform();

  if (platform === 'darwin') return pickDarwin(prompt, runner);
  if (platform === 'linux') return pickLinux(prompt, runner, which);
  if (platform === 'win32') return pickWin32(prompt, runner);
  return { path: null, cancelled: false, platform: 'unsupported' };
}
