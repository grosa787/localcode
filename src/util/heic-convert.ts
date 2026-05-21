/**
 * HEIC → PNG conversion using whatever native tool is on the user's
 * PATH. Vision-capable LLMs (GPT-4o, Gemini, Claude Sonnet, Llama-3.2
 * Vision, Qwen-VL) generally do NOT accept the HEIC container — even
 * though it's the iPhone default. Converting to PNG before sending is
 * the most reliable path.
 *
 * We try two external tools in order:
 *
 *   1. `sips` — bundled with every macOS install. Fast (Apple's ImageIO).
 *   2. `magick` — ImageMagick. Cross-platform. Slower than sips but
 *                 widely available; many Linux distros ship it by
 *                 default and `brew install imagemagick` covers macOS.
 *
 * When neither tool is available, we return `{ ok: false, message:
 * "HEIC requires sips (macOS) or magick" }` so the caller can surface a
 * toast and leave the HEIC file in place. We never crash the composer
 * just because we can't convert one image.
 *
 * The converted PNG lands in the OS temp dir under a UUID-prefixed
 * filename so multiple HEICs from the same session don't collide. The
 * caller is responsible for deciding when to clean it up (usually after
 * the file has been read into a data URL).
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface HeicConvertSuccess {
  readonly ok: true;
  /** Absolute path to the converted PNG. */
  readonly outputPath: string;
  /** Tool that performed the conversion — useful for diagnostics. */
  readonly tool: 'sips' | 'magick';
}

export interface HeicConvertFailure {
  readonly ok: false;
  /** Short user-facing message. */
  readonly message: string;
}

export type HeicConvertResult = HeicConvertSuccess | HeicConvertFailure;

/**
 * Hook so tests can stub the subprocess layer without monkey-patching
 * `child_process`. Production callers pass the default; tests inject a
 * synchronous fake that returns whatever exit code they want.
 */
export interface HeicConvertDeps {
  /** Run a one-shot subprocess and return its result. */
  spawn?: typeof spawnSync;
  /** `existsSync`-equivalent for the produced PNG. */
  exists?: (p: string) => boolean;
  /** Override the temp dir (tests). */
  tmpDir?: string;
}

const DEFAULT_DEPS: Required<HeicConvertDeps> = {
  spawn: spawnSync,
  exists: (p) => fs.existsSync(p),
  tmpDir: os.tmpdir(),
};

/**
 * Convert a HEIC file at `inputPath` to a fresh PNG in the OS temp dir.
 *
 * The function is synchronous because callers (InputBar's image-promote
 * pipeline) are already on the keystroke-blocking path — a few ms of
 * subprocess work is acceptable compared to running an async ladder
 * inside the keypress dispatcher. Returns `{ ok: false }` when neither
 * `sips` nor `magick` is available; callers should fall back to a toast.
 */
export function convertHeicToPng(
  inputPath: string,
  deps?: HeicConvertDeps,
): HeicConvertResult {
  const d: Required<HeicConvertDeps> = {
    spawn: deps?.spawn ?? DEFAULT_DEPS.spawn,
    exists: deps?.exists ?? DEFAULT_DEPS.exists,
    tmpDir: deps?.tmpDir ?? DEFAULT_DEPS.tmpDir,
  };
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { ok: false, message: 'HEIC convert: input path is empty' };
  }
  const stem = path.basename(inputPath, path.extname(inputPath));
  const id = randomId();
  const output = path.join(d.tmpDir, `localcode-heic-${id}-${stem}.png`);

  // Try sips first — it's macOS-native and faster than ImageMagick.
  const sipsResult = trySips(d.spawn, inputPath, output);
  if (sipsResult === 'ok' && d.exists(output)) {
    return { ok: true, outputPath: output, tool: 'sips' };
  }
  // Then ImageMagick.
  const magickResult = tryMagick(d.spawn, inputPath, output);
  if (magickResult === 'ok' && d.exists(output)) {
    return { ok: true, outputPath: output, tool: 'magick' };
  }
  return {
    ok: false,
    message: 'HEIC requires sips (macOS) or magick',
  };
}

type ToolOutcome = 'ok' | 'not-found' | 'failed';

function trySips(
  spawn: typeof spawnSync,
  input: string,
  output: string,
): ToolOutcome {
  const result = safeSpawn(spawn, 'sips', [
    '-s',
    'format',
    'png',
    input,
    '--out',
    output,
  ]);
  return interpretResult(result);
}

function tryMagick(
  spawn: typeof spawnSync,
  input: string,
  output: string,
): ToolOutcome {
  const result = safeSpawn(spawn, 'magick', [input, output]);
  return interpretResult(result);
}

function safeSpawn(
  spawn: typeof spawnSync,
  cmd: string,
  args: readonly string[],
): SpawnSyncReturns<Buffer> | null {
  try {
    return spawn(cmd, [...args], { encoding: 'buffer', timeout: 15_000 });
  } catch {
    return null;
  }
}

function interpretResult(result: SpawnSyncReturns<Buffer> | null): ToolOutcome {
  if (result === null) return 'not-found';
  // `spawnSync` populates `error.code === 'ENOENT'` when the binary is
  // missing. `status === null` also indicates the process never ran.
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return 'not-found';
  }
  if (result.status === null) return 'not-found';
  if (result.status === 0) return 'ok';
  return 'failed';
}

function randomId(): string {
  // Use crypto.randomUUID if available (Bun + modern Node); fall back
  // to Math.random + Date.now for hostile/old environments.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
