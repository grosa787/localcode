/**
 * /init — scan the current project and generate a LOCALCODE.md file.
 *
 * Flow:
 *   1. Announce the scan to the user via `ctx.print`.
 *   2. Delegate project scanning to the injected `scanProject` fn.
 *   3. Read any existing LOCALCODE.md so the LLM can update it in place.
 *   4. Build the generation prompt via the injected `buildInitPrompt` fn.
 *   5. Stream the LLM response; accumulate chunks into a single string.
 *   6. Write the final content via the injected `writeLocalcodeMd` fn.
 *
 * Dependencies are supplied by Agent 8 at wire-up time — this file does
 * NOT import from `@/init/` directly so we don't couple the commands
 * module to the project-scanner implementation.
 */

import type { LLMAdapter } from '@/llm/adapter';
import type { ContextManager } from '@/llm/context-manager';
import type {
  Message,
  SlashCommand,
  CommandContext,
} from '@/types/global';

/**
 * Structural type mirroring `ScanResult` in `@/init/project-scanner`.
 * We redeclare locally so this file compiles even if Agent 7 hasn't
 * landed their module yet. Once Agent 7 exports a compatible shape the
 * two types line up structurally.
 */
export interface ScanResultShape {
  tree: string;
  fileCount: number;
  totalSize: number;
  keyFiles: Array<{
    path: string;
    content: string;
    type: string;
  }>;
  languages: string[];
}

export interface InitDeps {
  llm: LLMAdapter;
  contextManager: ContextManager;
  scanProject: (root: string) => Promise<ScanResultShape>;
  writeLocalcodeMd: (root: string, content: string) => void;
  readLocalcodeMd: (root: string) => string | null;
  buildInitPrompt: (
    scan: ScanResultShape,
    existing: string | null,
  ) => string;
}

const INIT_NAME = 'init';
const INIT_DESCRIPTION =
  'Scan this project and generate (or update) .localcode/LOCALCODE.md';
const INIT_USAGE = '/init';

/**
 * Factory that returns the `/init` SlashCommand with its dependencies
 * captured in a closure.
 */
export function createInitCommand(deps: InitDeps): SlashCommand {
  const {
    llm,
    contextManager,
    scanProject,
    writeLocalcodeMd,
    readLocalcodeMd,
    buildInitPrompt,
  } = deps;

  return {
    name: INIT_NAME,
    description: INIT_DESCRIPTION,
    usage: INIT_USAGE,
    execute: async (_args: string, ctx: CommandContext): Promise<void> => {
      ctx.print('Scanning project...');

      let scan: ScanResultShape;
      try {
        scan = await scanProject(ctx.projectRoot);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Failed to scan project: ${msg}`);
        return;
      }

      ctx.print(
        `Scanned ${scan.fileCount} files (${formatBytes(scan.totalSize)}). ` +
          `Detected: ${scan.languages.length > 0 ? scan.languages.join(', ') : 'unknown'}`,
      );

      let existing: string | null = null;
      try {
        existing = readLocalcodeMd(ctx.projectRoot);
      } catch {
        // Best-effort — a missing file is fine, a broken one is surfaced
        // only if writing later also fails.
        existing = null;
      }
      if (existing !== null) {
        ctx.print('Existing LOCALCODE.md detected — updating in place.');
      }

      const prompt = buildInitPrompt(scan, existing);

      // Build a one-shot message list for the generation request. We do
      // NOT mutate `contextManager` — /init is a side-channel conversation
      // that shouldn't pollute the chat history.
      const systemPrompt = contextManager.buildSystemPrompt(existing, []);
      const messages: Message[] = [
        {
          id: `init-sys-${Date.now().toString(36)}`,
          role: 'system',
          content: systemPrompt,
          createdAt: Date.now(),
        },
        {
          id: `init-user-${Date.now().toString(36)}`,
          role: 'user',
          content: prompt,
          createdAt: Date.now(),
        },
      ];

      let accumulated = '';
      let streamError: string | null = null;
      let chunkCount = 0;

      ctx.print('Generating LOCALCODE.md...');

      try {
        await llm.streamChat({
          messages,
          onChunk: (text: string) => {
            accumulated += text;
            chunkCount += 1;
          },
          onDone: (result) => {
            if (result.error) streamError = result.error;
          },
        });
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`LLM stream failed: ${msg}`);
        return;
      }

      if (streamError !== null) {
        ctx.print(`LLM stream ended with error: ${streamError}`);
        return;
      }

      const cleaned = accumulated.trim();
      if (cleaned.length === 0) {
        ctx.print(
          `LLM returned no content after ${chunkCount} chunks — not writing.`,
        );
        return;
      }

      try {
        writeLocalcodeMd(ctx.projectRoot, cleaned);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Failed to write LOCALCODE.md: ${msg}`);
        return;
      }

      ctx.print('✓ LOCALCODE.md written');
    },
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  const precision = value >= 100 || unitIdx === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIdx] ?? 'B'}`;
}
