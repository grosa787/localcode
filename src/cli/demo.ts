/**
 * `localcode demo` — replay the bundled quick-tour recording.
 *
 * Loads `assets/demo/quick-tour.lcrec` (resolved relative to this file
 * so it works both in dev — `bun src/cli.tsx demo` — and in the bundled
 * binary — `localcode demo`), then streams every entry to stdout at the
 * original pace.
 *
 * The runner does NOT mount ink — keeping it terminal-agnostic means
 * the demo also works in CI, piped-output scenarios, and inside the
 * embed-via-`/demo`-slash-command path (which feeds the same dispatch
 * into the chat log instead of stdout).
 *
 * Two-tier resolution for the recording path:
 *   1. Sibling to the running script via `path.dirname(import.meta.url)`
 *      ascended to the package root + `assets/demo/quick-tour.lcrec`.
 *   2. `<cwd>/assets/demo/quick-tour.lcrec` as a fallback for dev mode
 *      where the bundle's structure differs.
 *
 * Errors surface a single-line message to stderr and the CLI exits with
 * a non-zero code so shell pipelines can detect failure.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Player, loadRecording, type Recording, type RecordingEntry } from '@/recordings';

/**
 * Resolve the bundled recording on disk. Tries the on-bundle relative
 * path first, then the dev-mode path. Returns the first existing path
 * or throws when neither is found.
 */
export async function resolveDemoRecordingPath(): Promise<string> {
  const candidates: string[] = [];
  try {
    // import.meta.url points at src/cli/demo.ts in dev and at the
    // bundled cli.js in production. From either we walk up to the
    // package root (`localcode/`) and append `assets/demo/...`.
    const here = fileURLToPath(import.meta.url);
    const dir = path.dirname(here);
    // Dev: src/cli/demo.ts → up 2 → localcode/
    candidates.push(path.resolve(dir, '..', '..', 'assets', 'demo', 'quick-tour.lcrec'));
    // Bundled: dist/cli.js → up 1 → localcode/
    candidates.push(path.resolve(dir, '..', 'assets', 'demo', 'quick-tour.lcrec'));
  } catch {
    // Some test harnesses lack `import.meta.url` — fall through to cwd.
  }
  candidates.push(path.resolve(process.cwd(), 'assets', 'demo', 'quick-tour.lcrec'));

  for (const c of candidates) {
    try {
      const stat = await fs.stat(c);
      if (stat.isFile()) return c;
    } catch {
      // try next
    }
  }
  throw new Error(
    `Bundled demo recording not found. Tried:\n  ${candidates.join('\n  ')}`,
  );
}

export interface DemoCliDeps {
  /** Output sink. Defaults to stdout. */
  readonly writeLine?: (line: string) => void;
  /** Error sink. Defaults to stderr. */
  readonly writeError?: (line: string) => void;
  /** Test seam: load function. Defaults to disk loader. */
  readonly loadFn?: (filePath: string) => Promise<Recording>;
  /** Test seam: alternate path resolver. */
  readonly resolveFn?: () => Promise<string>;
  /**
   * Test seam: replace `setTimeout` so the runner is fast in CI. Defaults
   * to `globalThis.setTimeout`.
   */
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
}

/** Format a single recording entry as a single output line. */
export function formatEntry(entry: RecordingEntry): string {
  switch (entry.kind) {
    case 'user':
      return `[you]      ${entry.content}`;
    case 'assistant':
      return `[localcode] ${entry.content}`;
    case 'tool_call':
      return `[tool ${entry.name}] ${entry.result.split('\n')[0] ?? ''}`;
    case 'system':
      return `[info]     ${entry.content}`;
  }
}

/**
 * Execute `localcode demo`. Returns the process exit code (0 on
 * success, 1 on failure). Never throws.
 */
export async function runDemo(deps: DemoCliDeps = {}): Promise<number> {
  const writeLine =
    deps.writeLine ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  const writeError =
    deps.writeError ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
  const resolveFn = deps.resolveFn ?? resolveDemoRecordingPath;
  const loadFn = deps.loadFn ?? loadRecording;

  let recordingPath: string;
  try {
    recordingPath = await resolveFn();
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    writeError(`localcode demo: ${msg}`);
    return 1;
  }

  let rec: Recording;
  try {
    rec = await loadFn(recordingPath);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    writeError(`localcode demo: failed to load recording: ${msg}`);
    return 1;
  }

  writeLine(`Replaying ${rec.id} (${rec.entries.length} entries) at 1x speed.`);
  writeLine('');

  const player = new Player(
    deps.setTimeoutFn !== undefined
      ? { setTimeoutFn: deps.setTimeoutFn }
      : {},
  );
  try {
    await player.replay(rec, (entry) => {
      writeLine(formatEntry(entry));
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    writeError(`localcode demo: replay failed: ${msg}`);
    return 1;
  }

  writeLine('');
  writeLine('Demo finished. Run `localcode` to start a real session.');
  return 0;
}
