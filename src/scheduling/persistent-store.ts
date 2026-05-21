/**
 * Persistent store for cross-session cron entries.
 *
 * On-disk layout: `~/.localcode/crons.json`
 *
 * ```json
 * {
 *   "version": 1,
 *   "crons": [
 *     {
 *       "id": "cron-…",
 *       "cronSpec": "0 9 * * *",
 *       "prompt": "summarise yesterday",
 *       "model": "qwen2.5-coder",
 *       "projectRoot": "/Users/me/proj",
 *       "lastFiredAt": 1747700000000,
 *       "enabled": true
 *     }
 *   ]
 * }
 * ```
 *
 * Writes are atomic (`tmp + rename`) so a crash mid-save never corrupts
 * the file. Reads tolerate a missing file (treated as empty), but
 * malformed JSON or shape mismatch throws — corrupt persistent state
 * should NOT silently disappear.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PersistentCronEntry {
  /** Stable identifier — `cron-<uuid>`. */
  readonly id: string;
  /** 5-field cron expression. */
  readonly cronSpec: string;
  /** Prompt body forwarded as a synthetic user turn on fire. */
  readonly prompt: string;
  /** Optional model override; otherwise the active config model wins. */
  readonly model?: string;
  /** Optional project root binding; otherwise the daemon's cwd is used. */
  readonly projectRoot?: string;
  /** Last fire time (ms since epoch). `undefined` if never fired. */
  readonly lastFiredAt?: number;
  /** Disabled entries are skipped at schedule time. */
  readonly enabled: boolean;
}

export interface PersistentCronFile {
  readonly version: 1;
  readonly crons: readonly PersistentCronEntry[];
}

export class PersistentStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistentStoreError';
  }
}

const CURRENT_VERSION = 1;

/** Default path: `~/.localcode/crons.json`. */
export function defaultCronStorePath(): string {
  return path.join(os.homedir(), '.localcode', 'crons.json');
}

/**
 * Load cron entries from disk. Missing file → empty list. Malformed
 * JSON / shape mismatch → `PersistentStoreError`.
 */
export async function loadCronStore(
  filePath: string = defaultCronStorePath(),
): Promise<PersistentCronFile> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { version: CURRENT_VERSION, crons: [] };
    }
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new PersistentStoreError(
      `Failed to read cron store at ${filePath}: ${msg}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new PersistentStoreError(
      `Cron store at ${filePath} is not valid JSON: ${msg}`,
    );
  }
  return validateFile(parsed, filePath);
}

/**
 * Persist cron entries atomically. Creates the parent directory if
 * missing.
 */
export async function saveCronStore(
  data: PersistentCronFile,
  filePath: string = defaultCronStorePath(),
): Promise<void> {
  const validated = validateFile(data, filePath);
  const parent = path.dirname(filePath);
  await fs.mkdir(parent, { recursive: true });
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  const tmp = `${filePath}.tmp`;
  try {
    await fs.writeFile(tmp, serialized, 'utf8');
    await fs.rename(tmp, filePath);
  } catch (cause) {
    try {
      await fs.unlink(tmp);
    } catch {
      // best-effort
    }
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new PersistentStoreError(
      `Failed to write cron store to ${filePath}: ${msg}`,
    );
  }
}

/**
 * Read-modify-write helper. Loads the store, applies `mutator`, and
 * writes the result back. Serialises concurrent callers via a process-
 * local lock map keyed on the file path — multiple writers in the same
 * process won't trample each other.
 */
const locks = new Map<string, Promise<void>>();

export async function updateCronStore(
  mutator: (current: PersistentCronFile) => PersistentCronFile,
  filePath: string = defaultCronStorePath(),
): Promise<PersistentCronFile> {
  const prior = locks.get(filePath) ?? Promise.resolve();
  let release: () => void = (): void => undefined;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(filePath, prior.then(() => next));
  await prior;
  try {
    const current = await loadCronStore(filePath);
    const updated = mutator(current);
    await saveCronStore(updated, filePath);
    return updated;
  } finally {
    release();
    if (locks.get(filePath) === next) locks.delete(filePath);
  }
}

function validateFile(raw: unknown, filePath: string): PersistentCronFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PersistentStoreError(
      `Cron store at ${filePath} is not a JSON object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const version = obj['version'];
  if (version !== CURRENT_VERSION) {
    throw new PersistentStoreError(
      `Cron store at ${filePath} has unsupported version ${String(version)} (expected ${CURRENT_VERSION})`,
    );
  }
  const cronsRaw = obj['crons'];
  if (!Array.isArray(cronsRaw)) {
    throw new PersistentStoreError(
      `Cron store at ${filePath} 'crons' must be an array`,
    );
  }
  const crons: PersistentCronEntry[] = cronsRaw.map((entry, idx) =>
    validateEntry(entry, idx, filePath),
  );
  return { version: CURRENT_VERSION, crons };
}

function validateEntry(
  raw: unknown,
  index: number,
  filePath: string,
): PersistentCronEntry {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PersistentStoreError(
      `Cron entry #${index} in ${filePath} is not an object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const id = obj['id'];
  const cronSpec = obj['cronSpec'];
  const prompt = obj['prompt'];
  const enabled = obj['enabled'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new PersistentStoreError(
      `Cron entry #${index} 'id' must be a non-empty string`,
    );
  }
  if (typeof cronSpec !== 'string' || cronSpec.length === 0) {
    throw new PersistentStoreError(
      `Cron entry #${index} 'cronSpec' must be a non-empty string`,
    );
  }
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new PersistentStoreError(
      `Cron entry #${index} 'prompt' must be a non-empty string`,
    );
  }
  if (typeof enabled !== 'boolean') {
    throw new PersistentStoreError(
      `Cron entry #${index} 'enabled' must be a boolean`,
    );
  }
  const model = obj['model'];
  const projectRoot = obj['projectRoot'];
  const lastFiredAt = obj['lastFiredAt'];
  if (model !== undefined && typeof model !== 'string') {
    throw new PersistentStoreError(
      `Cron entry #${index} 'model' must be a string when present`,
    );
  }
  if (projectRoot !== undefined && typeof projectRoot !== 'string') {
    throw new PersistentStoreError(
      `Cron entry #${index} 'projectRoot' must be a string when present`,
    );
  }
  if (
    lastFiredAt !== undefined &&
    (typeof lastFiredAt !== 'number' || !Number.isFinite(lastFiredAt))
  ) {
    throw new PersistentStoreError(
      `Cron entry #${index} 'lastFiredAt' must be a finite number when present`,
    );
  }
  return {
    id,
    cronSpec,
    prompt,
    model: typeof model === 'string' ? model : undefined,
    projectRoot: typeof projectRoot === 'string' ? projectRoot : undefined,
    lastFiredAt: typeof lastFiredAt === 'number' ? lastFiredAt : undefined,
    enabled,
  };
}

/** Random id helper used by callers that don't want to import `crypto`. */
export function newCronId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const tail =
    c?.randomUUID !== undefined
      ? c.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `cron-${tail}`;
}
