/**
 * `write_file` tool — two-phase write with approval.
 *
 * Phase 1 (`writeFile`) produces a unified-diff preview without touching the
 * filesystem. The tool-executor shows the diff to the user.
 * Phase 2 (`commitWrite`) actually writes the file (and any missing parent
 * directories) after approval.
 *
 * Path traversal is blocked; arguments are validated with Zod.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';

import { resolveSafePathStrict } from './path-safety';
import type { ToolContext, ToolResult, WriteFileArgs } from './types';

/** Zod schema for `write_file` arguments. */
export const WriteFileArgsSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
  content: z.string(),
});

async function readExisting(absolutePath: string): Promise<string | null> {
  try {
    return await fs.readFile(absolutePath, 'utf8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Preview a write as a unified diff. Does NOT write the file. Always reports
 * `requiresApproval: true` so the executor can prompt the user.
 */
export async function writeFile(
  args: WriteFileArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = WriteFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      requiresApproval: true,
    };
  }

  // H6 — strict resolve also blocks symlinked path components.
  const absolutePath = resolveSafePathStrict(ctx.projectRoot, parsed.data.path);
  if (absolutePath === null) {
    return {
      success: false,
      output: '',
      error: `Path traversal blocked: '${parsed.data.path}' escapes project root`,
      requiresApproval: true,
    };
  }

  try {
    const existing = await readExisting(absolutePath);
    const oldContent = existing ?? '';
    const label = parsed.data.path;
    const diff = createTwoFilesPatch(
      label,
      label,
      oldContent,
      parsed.data.content,
      existing === null ? '(new file)' : undefined,
      undefined,
    );

    return {
      success: true,
      output: diff,
      requiresApproval: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `Failed to prepare diff for '${parsed.data.path}': ${message}`,
      requiresApproval: true,
    };
  }
}

/**
 * Commit a previously-previewed write. Creates parent directories as needed.
 * Call this only after the user approves the diff returned by `writeFile`.
 */
export async function commitWrite(
  args: WriteFileArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = WriteFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }

  // H6 — strict resolve also blocks symlinked path components.
  const absolutePath = resolveSafePathStrict(ctx.projectRoot, parsed.data.path);
  if (absolutePath === null) {
    return {
      success: false,
      output: '',
      error: `Path traversal blocked: '${parsed.data.path}' escapes project root`,
    };
  }

  try {
    const parentDir = path.dirname(absolutePath);
    await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(absolutePath, parsed.data.content, 'utf8');
    const bytes = Buffer.byteLength(parsed.data.content, 'utf8');
    const output =
      parsed.data.content.length === 0
        ? `Wrote 0 lines (empty file) to ${parsed.data.path}`
        : (() => {
            const lineCount = parsed.data.content.split('\n').length;
            return `Wrote ${lineCount} line${lineCount === 1 ? '' : 's'} (${bytes} bytes) to ${parsed.data.path}`;
          })();
    return {
      success: true,
      output,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `Failed to write '${parsed.data.path}': ${message}`,
    };
  }
}
