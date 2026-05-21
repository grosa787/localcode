/**
 * Local plugin registry — tracks installed plugins in a `plugins.json`
 * file at either the global (`~/.localcode/plugins.json`) or project
 * (`<projectRoot>/.localcode/plugins.json`) scope.
 *
 * The registry is the authoritative list of *installed* plugins:
 *   - `install(sourcePath)` copies a plugin directory into the scope's
 *     `<scope>/.localcode/plugins/<id>/` location, validates the
 *     manifest, and records an entry in `plugins.json`.
 *   - `uninstall(id)` removes the directory + entry.
 *   - `enable(id)` / `disable(id)` toggle a flag without touching disk
 *     beyond the registry file.
 *   - `list()` returns the current entries (sorted by id).
 *
 * The on-disk format is JSON with a top-level `version: 1` field so we
 * can migrate the shape in the future. Reads tolerate a missing file
 * (return empty list). Writes are atomic (tmp file, then rename) so a
 * crash mid-write never leaves a half-written `plugins.json` on disk.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { parsePluginManifest, type PluginManifest } from './sdk/types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const RegistryEntrySchema = z
  .object({
    id: z.string().min(1),
    sourcePath: z.string().min(1),
    enabled: z.boolean(),
    installedAt: z.number().int().nonnegative(),
    manifestSnapshot: z.record(z.unknown()),
  })
  .strict();

export type PluginRegistryEntry = z.infer<typeof RegistryEntrySchema>;

const RegistryFileSchema = z
  .object({
    version: z.literal(1),
    plugins: z.array(RegistryEntrySchema),
  })
  .strict();

export type PluginRegistryFile = z.infer<typeof RegistryFileSchema>;

export type PluginScope = 'global' | 'project';

export interface PluginRegistryOptions {
  /** Scope this registry instance writes to. */
  scope: PluginScope;
  /**
   * Override for the registry root. When omitted defaults to:
   *   - global  → `~/.localcode/`
   *   - project → `<projectRoot>/.localcode/`
   * Used by tests and by callers that want to point the registry at a
   * non-default location.
   */
  rootDir?: string;
  /**
   * For `scope = 'project'`, the project root used to derive the
   * default registry root. Ignored when `rootDir` is supplied.
   */
  projectRoot?: string;
  /**
   * Clock override — primarily for tests. Returns the value used as
   * `installedAt` when a new entry is added.
   */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Public class
// ---------------------------------------------------------------------------

export class PluginRegistryError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'PluginRegistryError';
  }
}

export class PluginRegistry {
  readonly scope: PluginScope;
  readonly rootDir: string;
  private readonly now: () => number;

  constructor(options: PluginRegistryOptions) {
    this.scope = options.scope;
    this.now = options.now ?? ((): number => Date.now());
    if (typeof options.rootDir === 'string' && options.rootDir.length > 0) {
      this.rootDir = options.rootDir;
    } else if (options.scope === 'global') {
      this.rootDir = path.join(homedir(), '.localcode');
    } else {
      if (typeof options.projectRoot !== 'string' || options.projectRoot.length === 0) {
        throw new PluginRegistryError(
          'PluginRegistry: project scope requires either rootDir or projectRoot',
        );
      }
      this.rootDir = path.join(options.projectRoot, '.localcode');
    }
  }

  /** Absolute path to the registry JSON file. */
  get filePath(): string {
    return path.join(this.rootDir, 'plugins.json');
  }

  /** Absolute path to the installed-plugins root directory. */
  get pluginsDir(): string {
    return path.join(this.rootDir, 'plugins');
  }

  /** Read the registry from disk; returns the empty list when missing. */
  async list(): Promise<PluginRegistryEntry[]> {
    const file = await this.readFile();
    return [...file.plugins].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Lookup a single entry by id. */
  async get(id: string): Promise<PluginRegistryEntry | null> {
    const entries = await this.list();
    return entries.find((e) => e.id === id) ?? null;
  }

  /**
   * Install a plugin from a local directory. The source directory must
   * contain a `localcode-plugin.json` manifest. The directory is copied
   * into `<rootDir>/plugins/<id>/` (replacing any existing copy with the
   * same id) and a registry entry is written.
   *
   * Returns the new entry. Throws `PluginRegistryError` on validation
   * failure or filesystem errors.
   */
  async install(sourcePath: string): Promise<PluginRegistryEntry> {
    const absSource = path.resolve(sourcePath);
    const manifestPath = path.join(absSource, 'localcode-plugin.json');

    let manifestText: string;
    try {
      manifestText = await fs.readFile(manifestPath, 'utf8');
    } catch (cause) {
      throw new PluginRegistryError(
        `install: cannot read manifest at ${manifestPath}`,
        cause,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(manifestText);
    } catch (cause) {
      throw new PluginRegistryError(
        `install: manifest at ${manifestPath} is not valid JSON`,
        cause,
      );
    }
    const parsed = parsePluginManifest(raw);
    if (!parsed.ok) {
      throw new PluginRegistryError(
        `install: invalid manifest at ${manifestPath} — ${parsed.error}`,
      );
    }
    const manifest: PluginManifest = parsed.manifest;

    // Copy the source directory into <rootDir>/plugins/<id>/.
    const targetDir = path.join(this.pluginsDir, manifest.id);
    try {
      await fs.mkdir(this.pluginsDir, { recursive: true });
    } catch (cause) {
      throw new PluginRegistryError(
        `install: failed to create ${this.pluginsDir}`,
        cause,
      );
    }
    // Clear any prior copy so re-install starts clean.
    try {
      await fs.rm(targetDir, { recursive: true, force: true });
    } catch (cause) {
      throw new PluginRegistryError(
        `install: failed to clear prior ${targetDir}`,
        cause,
      );
    }
    try {
      await copyDir(absSource, targetDir);
    } catch (cause) {
      throw new PluginRegistryError(
        `install: failed to copy ${absSource} → ${targetDir}`,
        cause,
      );
    }

    const entry: PluginRegistryEntry = {
      id: manifest.id,
      sourcePath: targetDir,
      enabled: true,
      installedAt: this.now(),
      manifestSnapshot: raw as Record<string, unknown>,
    };

    const file = await this.readFile();
    const withoutOld = file.plugins.filter((e) => e.id !== manifest.id);
    withoutOld.push(entry);
    await this.writeFile({ version: 1, plugins: withoutOld });
    return entry;
  }

  /**
   * Remove a plugin by id. Deletes the on-disk directory + the registry
   * entry. Returns `false` if the id was not registered.
   */
  async uninstall(id: string): Promise<boolean> {
    const file = await this.readFile();
    const before = file.plugins.length;
    const remaining = file.plugins.filter((e) => e.id !== id);
    if (remaining.length === before) return false;

    const targetDir = path.join(this.pluginsDir, id);
    try {
      await fs.rm(targetDir, { recursive: true, force: true });
    } catch (cause) {
      throw new PluginRegistryError(
        `uninstall: failed to remove ${targetDir}`,
        cause,
      );
    }
    await this.writeFile({ version: 1, plugins: remaining });
    return true;
  }

  /** Toggle `enabled` on a registered plugin. Returns the updated entry. */
  async enable(id: string): Promise<PluginRegistryEntry> {
    return this.setEnabled(id, true);
  }

  async disable(id: string): Promise<PluginRegistryEntry> {
    return this.setEnabled(id, false);
  }

  private async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<PluginRegistryEntry> {
    const file = await this.readFile();
    const updated: PluginRegistryEntry[] = [];
    let found: PluginRegistryEntry | null = null;
    for (const entry of file.plugins) {
      if (entry.id === id) {
        const next: PluginRegistryEntry = { ...entry, enabled };
        updated.push(next);
        found = next;
      } else {
        updated.push(entry);
      }
    }
    if (found === null) {
      throw new PluginRegistryError(`setEnabled: no plugin registered with id "${id}"`);
    }
    await this.writeFile({ version: 1, plugins: updated });
    return found;
  }

  // -------------------------------------------------------------------------
  // I/O — tmp-then-rename atomic writes
  // -------------------------------------------------------------------------

  private async readFile(): Promise<PluginRegistryFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return { version: 1, plugins: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new PluginRegistryError(
        `Failed to parse ${this.filePath}: ${describe(cause)}`,
      );
    }
    const result = RegistryFileSchema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      const message = issue
        ? `${issue.path.join('.') || '<root>'}: ${issue.message}`
        : 'invalid registry file';
      throw new PluginRegistryError(
        `Invalid registry file ${this.filePath}: ${message}`,
      );
    }
    return result.data;
  }

  private async writeFile(file: PluginRegistryFile): Promise<void> {
    try {
      await fs.mkdir(this.rootDir, { recursive: true });
    } catch (cause) {
      throw new PluginRegistryError(
        `Failed to create ${this.rootDir}: ${describe(cause)}`,
      );
    }
    const sorted: PluginRegistryFile = {
      version: 1,
      plugins: [...file.plugins].sort((a, b) => a.id.localeCompare(b.id)),
    };
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify(sorted, null, 2)}\n`;
    try {
      await fs.writeFile(tmp, body, 'utf8');
      await fs.rename(tmp, this.filePath);
    } catch (cause) {
      try {
        await fs.rm(tmp, { force: true });
      } catch {
        // best-effort cleanup
      }
      throw new PluginRegistryError(
        `Failed to write ${this.filePath}: ${describe(cause)}`,
        cause,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, dstPath);
    }
    // Skip symlinks / sockets / etc. — plugins shouldn't ship them.
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}
