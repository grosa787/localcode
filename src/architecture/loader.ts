/**
 * Loader for `.localcode/arch.toml`.
 *
 * Returns `null` when the file is absent — that's the "no architecture
 * rules configured" branch and is treated as a non-error. Parse failures
 * AND Zod validation failures throw `ArchConfigError` so the caller (CLI
 * `/arch` command or PreToolUse hook) can surface a precise diagnostic.
 *
 * The loader is a thin filesystem wrapper — keep it side-effect free
 * besides the `readFile` call so tests can stub the path or pre-write
 * fixtures.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { ZodError } from 'zod';
import { ArchConfigSchema, type ArchConfig } from './types';

export class ArchConfigError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly issues?: ZodError['issues'],
  ) {
    super(message);
    this.name = 'ArchConfigError';
  }
}

/**
 * Resolve the canonical arch.toml path for a project root.
 * Public so tests / `/arch init` can target it without re-deriving.
 */
export function archConfigPath(projectRoot: string): string {
  return path.join(projectRoot, '.localcode', 'arch.toml');
}

/**
 * Read and validate `<projectRoot>/.localcode/arch.toml`. Returns null
 * when the file does not exist. Throws ArchConfigError on parse or
 * validation failure.
 */
export function loadArchConfig(projectRoot: string): ArchConfig | null {
  const filePath = archConfigPath(projectRoot);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (cause) {
    const errno = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (errno === 'ENOENT') return null;
    throw new ArchConfigError(
      `Failed to read arch.toml at ${filePath}: ${errorMessage(cause)}`,
      cause,
    );
  }
  return parseArchConfigSource(raw, filePath);
}

/**
 * Parse a raw TOML string into a validated `ArchConfig`. Exported for
 * tests / `/arch check` flows that already have the source in memory.
 * `originPath` is used only for error messages.
 */
export function parseArchConfigSource(
  source: string,
  originPath: string,
): ArchConfig {
  let parsed: unknown;
  try {
    parsed = parseToml(source);
  } catch (cause) {
    throw new ArchConfigError(
      `Failed to parse arch.toml at ${originPath}: ${errorMessage(cause)}`,
      cause,
    );
  }

  // smol-toml decodes `[[rule]]` into `{ rule: [...] }` automatically.
  // `[global]` becomes `{ global: { ... } }`. Both fields are optional
  // at parse-time and the Zod schema fills in defaults.
  const result = ArchConfigSchema.safeParse(parsed);
  if (!result.success) {
    const summary = describeIssues(result.error);
    throw new ArchConfigError(
      `arch.toml at ${originPath} failed validation: ${summary}`,
      undefined,
      result.error.issues,
    );
  }
  return result.data;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

function describeIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const p = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${p}: ${issue.message}`;
    })
    .join('; ');
}
