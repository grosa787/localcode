/**
 * Memory module barrel.
 *
 * Public surface:
 *   - MemoryStore        — CRUD for per-project memory entries
 *   - MemoryStoreError   — typed error class
 *   - MemoryEntry        — entry shape
 *   - MemoryType         — 'user' | 'feedback' | 'project' | 'reference'
 *   - MEMORY_TYPES       — tuple of all valid type values
 *   - MemoryFrontmatterSchema — Zod schema for frontmatter validation
 *   - MEMORY_NAME_RE     — slug validation regex
 */

export { MemoryStore, MemoryStoreError } from './store';
export type { MemoryEntry, MemoryType } from './types';
export {
  MEMORY_TYPES,
  MEMORY_NAME_RE,
  MemoryFrontmatterSchema,
  MemoryTypeSchema,
} from './types';
