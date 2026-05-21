/**
 * Memory system types — file-backed per-project memory entries.
 *
 * Each entry is a markdown file with YAML frontmatter under
 * `<projectRoot>/.localcode/memory/`. The `MEMORY.md` index at the
 * same root is a flat pointer list rebuilt by `MemoryStore.rebuildIndex`.
 *
 * Four types mirror Claude-Code memory semantics:
 *   - `user`      — user preferences and communication style.
 *   - `feedback`  — corrections and lessons the model should remember.
 *   - `project`   — project-specific facts (stack, conventions, paths).
 *   - `reference` — pointers to external resources or docs.
 */

import { z } from 'zod';

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryEntry {
  /** Unique slug — must match `[a-z0-9][a-z0-9_-]*`. Used as filename stem. */
  name: string;
  /** One-line description used for relevance matching / index. */
  description: string;
  type: MemoryType;
  /** Markdown body (everything after the frontmatter block). */
  body: string;
  /** Absolute path on disk — set by MemoryStore after read/write. */
  path: string;
}

export const MemoryTypeSchema = z.enum(MEMORY_TYPES);

/**
 * Zod schema for the YAML-frontmatter fields of a memory file.
 * Runtime boundary — applied to every file read from disk.
 */
export const MemoryFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'name must be lowercase alphanumeric with - or _'),
  description: z.string().min(1),
  type: MemoryTypeSchema,
});

export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>;

/** Slug validation regex — exported for reuse in write-path guards. */
export const MEMORY_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
