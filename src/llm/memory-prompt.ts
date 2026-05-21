/**
 * Pure renderer turning a list of {@link MemoryEntry} into the
 * pre-formatted string consumed by
 * `ContextManager.buildSystemPrompt({ memorySection })`.
 *
 * Lives outside `src/memory/` on purpose: the memory module owns
 * storage; this file owns wire-format. Keeping them separate means the
 * store can evolve (extra fields, indexing, etc.) without churning the
 * prompt-cache invariant guarded by
 * `tests/llm/system-prompt-bytestable.test.ts`.
 *
 * Byte-stability contract:
 *   - Entries are sorted by `name` (defensive — `MemoryStore.list()`
 *     already sorts, but a defensive sort here lets callers pass any
 *     iterable order safely).
 *   - Entry body whitespace is trimmed once.
 *   - Empty / whitespace-only output is returned as the empty string so
 *     `ContextManager.buildSystemPrompt` short-circuits the section and
 *     emits NO `## Memory` heading at all — keeps the prompt prefix
 *     byte-identical for projects with no memory yet.
 */

import type { MemoryEntry } from '@/memory';

/**
 * Render memory entries into a single string suitable for
 * `buildSystemPrompt({ memorySection })`. Pure function — identical
 * inputs always yield byte-identical output. Returns the empty string
 * for zero entries (the consumer treats that as "omit section").
 */
export function renderMemorySection(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return '';

  // Defensive sort. `MemoryStore.list()` sorts by name, but accepting
  // any iterable order keeps the wiring side robust.
  const sorted = entries
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const lines: string[] = [];
  for (const entry of sorted) {
    const body = entry.body.trim();
    // Header line — same across all entries: name + type + one-line desc.
    lines.push(`- [${entry.name}] (${entry.type}): ${entry.description}`);
    if (body.length > 0) {
      // Indent the body so the index entry stays visually associated
      // with its content. Two spaces match the markdown convention used
      // by `MemoryStore.rebuildIndex` for sub-lines.
      for (const ln of body.split('\n')) {
        lines.push(`  ${ln}`);
      }
    }
  }

  return lines.join('\n');
}
