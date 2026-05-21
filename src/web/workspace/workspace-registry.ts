/**
 * WorkspaceRegistry — multi-project store backed by
 * `~/.localcode/workspaces.json`.
 *
 * Atomic writes (tmp + rename), corruption recovery (back up bad file
 * and start fresh), de-duplication by absolute root path. Pure Node
 * APIs so the same code path runs under Bun and tests.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  WORKSPACES_FILE_PATH,
  WorkspacesFileSchema,
  type WorkspaceRecord,
  type WorkspacesFile,
} from './workspace-types.js';

export interface WorkspaceRegistryOptions {
  /** Override file path — primarily for tests. */
  filePath?: string;
}

export class WorkspaceRegistry {
  private cache: WorkspacesFile;
  private readonly filePath: string;

  constructor(opts?: WorkspaceRegistryOptions) {
    this.filePath = opts?.filePath ?? join(homedir(), WORKSPACES_FILE_PATH);
    this.cache = this.load();
  }

  /** Most-recently-used first. Returns a defensive copy. */
  list(): readonly WorkspaceRecord[] {
    return [...this.cache.workspaces].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  get(id: string): WorkspaceRecord | null {
    return this.cache.workspaces.find((w) => w.id === id) ?? null;
  }

  byRoot(root: string): WorkspaceRecord | null {
    const normalized = resolve(root);
    return this.cache.workspaces.find((w) => w.root === normalized) ?? null;
  }

  /**
   * Create or return the existing workspace for `root`. Touches
   * `lastUsedAt` when an existing record is matched so the row floats
   * to the top of `list()`.
   */
  create(root: string, label?: string): WorkspaceRecord {
    const normalized = resolve(root);
    if (!existsSync(normalized) || !statSync(normalized).isDirectory()) {
      throw new Error(`Project root does not exist or is not a directory: ${normalized}`);
    }
    const existing = this.byRoot(normalized);
    if (existing) {
      this.touch(existing.id);
      const refreshed = this.get(existing.id);
      if (refreshed === null) {
        // Should not happen — touch persists the same row. Defensive.
        throw new Error(`Workspace ${existing.id} disappeared after touch`);
      }
      return refreshed;
    }
    const record: WorkspaceRecord = {
      id: randomUUID(),
      root: normalized,
      label: label && label.length > 0 ? label : deriveLabel(normalized),
      lastUsedAt: Date.now(),
    };
    this.cache.workspaces.push(record);
    this.persist();
    return record;
  }

  remove(id: string): boolean {
    const before = this.cache.workspaces.length;
    this.cache.workspaces = this.cache.workspaces.filter((w) => w.id !== id);
    if (this.cache.workspaces.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  touch(id: string): void {
    const w = this.cache.workspaces.find((x) => x.id === id);
    if (!w) return;
    w.lastUsedAt = Date.now();
    this.persist();
  }

  // ---------- internal ----------

  private load(): WorkspacesFile {
    if (!existsSync(this.filePath)) {
      return { version: 1, workspaces: [] };
    }
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch {
      return { version: 1, workspaces: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.backup(raw);
      return { version: 1, workspaces: [] };
    }
    const result = WorkspacesFileSchema.safeParse(parsed);
    if (!result.success) {
      this.backup(raw);
      return { version: 1, workspaces: [] };
    }
    return result.data;
  }

  private backup(raw: string): void {
    try {
      const backupPath = `${this.filePath}.${Date.now()}.bak`;
      const dir = dirname(backupPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(backupPath, raw, 'utf-8');
    } catch {
      // best-effort; corruption recovery should never throw
    }
  }

  private persist(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf-8');
    renameSync(tmp, this.filePath);
  }
}

function deriveLabel(root: string): string {
  const base = basename(root);
  return base.length > 0 ? base : root;
}
