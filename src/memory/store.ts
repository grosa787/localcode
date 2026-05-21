/**
 * MemoryStore — CRUD for per-project memory entries.
 *
 * Storage layout:
 *   <projectRoot>/.localcode/memory/<name>.md  — one file per entry
 *   <projectRoot>/.localcode/memory/MEMORY.md  — flat index (rebuilt on write/remove)
 *
 * Each entry file uses YAML frontmatter:
 *   ---
 *   name: <slug>
 *   description: <one-liner>
 *   type: user | feedback | project | reference
 *   ---
 *   <markdown body>
 *
 * Writes are atomic: tmp file → rename.
 * Frontmatter is validated with Zod on every read.
 */

import * as path from 'node:path';
import {
  mkdir as fsMkdir,
  readdir as fsReaddir,
  readFile as fsReadFile,
  rename as fsRename,
  stat as fsStat,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises';

import {
  MEMORY_NAME_RE,
  MemoryFrontmatterSchema,
  type MemoryEntry,
  type MemoryType,
} from './types';

export { type MemoryEntry, type MemoryType } from './types';

// ---------- Errors ----------

export class MemoryStoreError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'MemoryStoreError';
  }
}

// ---------- Constants ----------

const MEMORY_EXT = '.md';
const INDEX_FILENAME = 'MEMORY.md';

// ---------- Helpers ----------

function memoryDir(projectRoot: string): string {
  return path.join(projectRoot, '.localcode', 'memory');
}

function indexPath(projectRoot: string): string {
  return path.join(memoryDir(projectRoot), INDEX_FILENAME);
}

function entryPath(projectRoot: string, name: string): string {
  return path.join(memoryDir(projectRoot), `${name}${MEMORY_EXT}`);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsStat(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await fsMkdir(dir, { recursive: true });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new MemoryStoreError(`Failed to create directory ${dir}: ${msg}`, cause);
  }
}

/**
 * Split raw file text into frontmatter block + body. Same logic as
 * `skill-parser.ts` — kept local so this module has no cross-module deps
 * beyond `./types`.
 */
function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const openMatch = /^---\r?\n/.exec(raw);
  if (!openMatch) return { frontmatter: null, body: raw };

  const afterOpen = openMatch[0].length;
  const rest = raw.slice(afterOpen);
  const closeRegex = /(^|\r?\n)---\r?\n?/;
  const closeMatch = closeRegex.exec(rest);
  if (!closeMatch) return { frontmatter: null, body: raw };

  const frontmatter = rest.slice(0, closeMatch.index);
  const bodyStart = closeMatch.index + closeMatch[0].length;
  return { frontmatter, body: rest.slice(bodyStart) };
}

/**
 * Parse a frontmatter block into a plain record of string values.
 * Mirrors `skill-parser.parseFrontmatter` — kept local for independence.
 */
function parseFrontmatterBlock(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    if (key.length === 0) continue;
    let value = trimmed.slice(colon + 1).trim();
    if (value.length >= 2) {
      const first = value.charAt(0);
      const last = value.charAt(value.length - 1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return out;
}

/**
 * Serialise a memory entry to on-disk markdown with YAML frontmatter.
 */
function serialise(entry: MemoryEntry): string {
  const fm = [
    '---',
    `name: ${entry.name}`,
    `description: ${entry.description}`,
    `type: ${entry.type}`,
    '---',
    '',
    entry.body.trimEnd(),
    '',
  ].join('\n');
  return fm;
}

/**
 * Parse a single memory file from disk. Throws `MemoryStoreError` on
 * read failures or frontmatter validation failures.
 */
async function parseMemoryFile(filePath: string): Promise<MemoryEntry> {
  let raw: string;
  try {
    raw = await fsReadFile(filePath, 'utf8');
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new MemoryStoreError(`Failed to read memory file ${filePath}: ${msg}`, cause);
  }

  const { frontmatter, body } = splitFrontmatter(raw);
  if (frontmatter === null) {
    throw new MemoryStoreError(
      `Memory file ${filePath} is missing frontmatter`,
    );
  }

  const fields = parseFrontmatterBlock(frontmatter);
  const result = MemoryFrontmatterSchema.safeParse(fields);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new MemoryStoreError(
      `Invalid memory frontmatter in ${filePath}: ${issues}`,
    );
  }

  return {
    name: result.data.name,
    description: result.data.description,
    type: result.data.type,
    body: body.replace(/^\r?\n+/, '').trimEnd(),
    path: filePath,
  };
}

// ---------- MemoryStore ----------

export class MemoryStore {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /** Absolute path to the memory directory for this project. */
  get directory(): string {
    return memoryDir(this.projectRoot);
  }

  /**
   * List all memory entries, sorted deterministically by `name`.
   * Files that fail to parse are skipped silently — a broken file
   * should not nuke the whole list.
   */
  async list(): Promise<MemoryEntry[]> {
    const dir = memoryDir(this.projectRoot);
    if (!(await pathExists(dir))) return [];

    let filenames: string[];
    try {
      filenames = await fsReaddir(dir);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new MemoryStoreError(`Failed to read memory dir ${dir}: ${msg}`, cause);
    }

    const mdFiles = filenames.filter(
      (f) => f.toLowerCase().endsWith(MEMORY_EXT) && f !== INDEX_FILENAME,
    );

    const entries: MemoryEntry[] = [];
    for (const file of mdFiles) {
      try {
        const entry = await parseMemoryFile(path.join(dir, file));
        entries.push(entry);
      } catch {
        // Skip broken files — a MemoryStoreError from a corrupt file
        // should not prevent valid entries from loading.
      }
    }

    // Deterministic sort by name for byte-stable system-prompt injection.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  /**
   * Get a single memory entry by name. Returns `null` when not found.
   */
  async get(name: string): Promise<MemoryEntry | null> {
    const fp = entryPath(this.projectRoot, name);
    if (!(await pathExists(fp))) return null;
    try {
      return await parseMemoryFile(fp);
    } catch {
      return null;
    }
  }

  // MEMORY-UPSERT-SECTION
  /**
   * Write (create or overwrite) a memory entry. Validates the entry
   * shape before writing. Uses atomic tmp→rename. Rebuilds `MEMORY.md`
   * after a successful write.
   *
   * Server-side validation:
   *   - slug matches `MEMORY_NAME_RE`
   *   - description ≤ 200 chars
   *   - body ≤ 50 KB
   */
  async write(entry: MemoryEntry): Promise<MemoryEntry> {
    if (!entry.name || !MEMORY_NAME_RE.test(entry.name)) {
      throw new MemoryStoreError(
        `Invalid memory name "${entry.name}": must match ${MEMORY_NAME_RE.source}`,
      );
    }
    if (!entry.description || entry.description.trim().length === 0) {
      throw new MemoryStoreError('Memory entry description cannot be empty');
    }
    if (entry.description.length > 200) {
      throw new MemoryStoreError(
        `Memory entry description too long (${entry.description.length} > 200 chars)`,
      );
    }
    // Body size guard — 50 KB upper bound matches the spec. Empty
    // bodies are rejected by the Zod schema upstream, but allow
    // any non-empty body here to keep the store reusable for tests.
    if (entry.body !== undefined && entry.body.length > 50 * 1024) {
      throw new MemoryStoreError(
        `Memory entry body too large (${entry.body.length} > 51200 bytes)`,
      );
    }
    // Validate type via Zod schema
    const result = MemoryFrontmatterSchema.safeParse({
      name: entry.name,
      description: entry.description,
      type: entry.type,
    });
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new MemoryStoreError(`Invalid memory entry: ${issues}`);
    }

    const dir = memoryDir(this.projectRoot);
    await ensureDir(dir);

    const fp = entryPath(this.projectRoot, entry.name);
    const tmp = `${fp}.tmp`;
    const content = serialise(entry);

    try {
      await fsWriteFile(tmp, content, 'utf8');
      await fsRename(tmp, fp);
    } catch (cause) {
      // Best-effort cleanup of orphan tmp file.
      try {
        if (await pathExists(tmp)) await fsUnlink(tmp);
      } catch {
        // swallow
      }
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new MemoryStoreError(
        `Failed to write memory entry "${entry.name}": ${msg}`,
        cause,
      );
    }

    await this.rebuildIndex();

    return { ...entry, path: fp };
  }
  // MEMORY-UPSERT-SECTION-END

  /**
   * Remove a memory entry by name. Silently succeeds if the file does
   * not exist. Rebuilds `MEMORY.md` after removal.
   */
  async remove(name: string): Promise<void> {
    if (!name || name.trim().length === 0) {
      throw new MemoryStoreError('Memory entry name cannot be empty');
    }
    const fp = entryPath(this.projectRoot, name);
    if (!(await pathExists(fp))) return;

    try {
      await fsUnlink(fp);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new MemoryStoreError(
        `Failed to remove memory entry "${name}": ${msg}`,
        cause,
      );
    }

    await this.rebuildIndex();
  }

  /**
   * Rebuild `MEMORY.md` — a flat pointer list of all current entries.
   * Sorted by `name` for determinism. Overwrites atomically.
   * Called automatically by `write` and `remove`.
   */
  async rebuildIndex(): Promise<string> {
    const entries = await this.list();
    const dir = memoryDir(this.projectRoot);
    await ensureDir(dir);

    let content: string;
    if (entries.length === 0) {
      content = '# Memory Index\n\n(no entries)\n';
    } else {
      const lines = entries.map(
        (e) => `- [${e.name}](${e.name}${MEMORY_EXT}) — ${e.description}`,
      );
      content = ['# Memory Index', '', ...lines, ''].join('\n');
    }

    const fp = indexPath(this.projectRoot);
    const tmp = `${fp}.tmp`;
    try {
      await fsWriteFile(tmp, content, 'utf8');
      await fsRename(tmp, fp);
    } catch (cause) {
      try {
        if (await pathExists(tmp)) await fsUnlink(tmp);
      } catch {
        // swallow
      }
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new MemoryStoreError(
        `Failed to rebuild memory index: ${msg}`,
        cause,
      );
    }

    return content;
  }
}
