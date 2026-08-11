/**
 * Vitest setup — `localStorage` shim for the jsdom environment.
 *
 * Node >= 22 ships its OWN `localStorage` global that is `undefined`
 * unless the process is started with `--localstorage-file`
 * ("ExperimentalWarning: localStorage is not available because
 * --localstorage-file was not provided"). That built-in shadows the one
 * jsdom installs, so `window.localStorage` reads as `undefined` and
 * every persistence assertion in `src/state/*.test.ts` throws
 * `Cannot read properties of undefined (reading 'getItem')` — on Node 26
 * this happens regardless of whether vitest is launched via node or bun.
 *
 * The app code always guards its localStorage access in try/catch, so
 * the failure is invisible in production but leaves the persistence
 * behaviour untested. A minimal in-memory Storage restores that
 * coverage. Installed ONLY when the global is genuinely missing, so a
 * runtime that provides a real one is never overridden.
 */

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

function install(target: object): void {
  const current = (target as { localStorage?: Storage }).localStorage;
  if (current !== undefined && current !== null) return;
  Object.defineProperty(target, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}

if (typeof globalThis !== 'undefined') install(globalThis);
if (typeof window !== 'undefined' && window !== globalThis) install(window);
