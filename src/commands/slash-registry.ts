/**
 * SlashRegistry — central registry of `/`-prefixed commands.
 *
 * Commands are registered once at app startup (by Agent 8's wiring layer)
 * and looked up by name or prefix-searched for autocomplete. Duplicate
 * registration throws — we'd rather fail fast than silently clobber a
 * command.
 *
 * The registry is purely data-structure — it holds `SlashCommand` records
 * but never invokes them. Actual execution is the caller's responsibility
 * (they pass the `CommandContext`).
 */

import type { SlashCommand } from '@/types/global';

export class SlashRegistryError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SlashRegistryError';
  }
}

export class SlashRegistry {
  private readonly commands = new Map<string, SlashCommand>();

  /**
   * Register a single command. Throws if a command with the same name
   * (case-insensitive) is already registered.
   */
  register(command: SlashCommand): void {
    if (!command.name || command.name.length === 0) {
      throw new SlashRegistryError('SlashCommand.name is required');
    }
    if (command.name.startsWith('/')) {
      throw new SlashRegistryError(
        `SlashCommand.name must not start with '/': ${command.name}`,
      );
    }
    const key = command.name.toLowerCase();
    if (this.commands.has(key)) {
      throw new SlashRegistryError(
        `SlashCommand already registered: /${command.name}`,
      );
    }
    this.commands.set(key, command);
  }

  /** Register many at once. Fails fast on the first duplicate. */
  registerAll(commands: readonly SlashCommand[]): void {
    for (const cmd of commands) this.register(cmd);
  }

  /**
   * Look up a command by exact name. Accepts the name with or without a
   * leading `/`. Case-insensitive.
   */
  get(name: string): SlashCommand | null {
    const cleaned = name.startsWith('/') ? name.slice(1) : name;
    const cmd = this.commands.get(cleaned.toLowerCase());
    return cmd ?? null;
  }

  /** All registered commands, in deterministic name order. */
  getAll(): SlashCommand[] {
    return [...this.commands.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /**
   * Prefix-match search for autocomplete. Case-insensitive. Returns the
   * full list (sorted by name) when `query` is empty or just `/`.
   */
  search(query: string): SlashCommand[] {
    const cleaned = query.startsWith('/') ? query.slice(1) : query;
    const needle = cleaned.toLowerCase();
    if (needle.length === 0) return this.getAll();
    return this.getAll().filter((c) => c.name.toLowerCase().startsWith(needle));
  }

  /** Drop every registered command. Primarily for tests. */
  clear(): void {
    this.commands.clear();
  }

  /** Count of registered commands. */
  get size(): number {
    return this.commands.size;
  }
}
