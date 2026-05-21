/**
 * Browser tools — eight `browser_*` LLM-callable handlers backed by a
 * single `BrowserSession` per chat session. Returned `ToolResult` values
 * use the same envelope conventions as the other tools:
 *   - text-only outputs are plain strings,
 *   - the `browser_screenshot` tool returns the same multimodal envelope
 *     as `fetch_image` (`{ kind: 'image', mimeType, dataBase64, byteLength }`)
 *     so vision-capable adapters splice it into the wire payload.
 *
 * None of the eight tools require approval. Schemas are exported for the
 * tool-schema registry; the handler factory adapts each method into the
 * `(args, ctx) => Promise<ToolResult>` shape that `createToolHandlerMap`
 * already speaks.
 */

import { z } from 'zod';

import type { ToolContext, ToolResult } from '@/tools/types';

import { createBrowserSession } from './session';
import type {
  BrowserConsoleEvent,
  BrowserSession,
  BrowserSessionOptions,
} from './types';

// ---------- Zod argument schemas ----------

export const BrowserNavigateArgsSchema = z.object({
  url: z.string().min(1),
});

export const BrowserScreenshotArgsSchema = z.object({}).strict();

export const BrowserClickArgsSchema = z
  .object({
    selector: z.string().min(1).optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
  })
  .refine(
    (a) =>
      (typeof a.selector === 'string' && a.selector.length > 0) ||
      (typeof a.x === 'number' && typeof a.y === 'number'),
    { message: 'click requires either selector or {x, y}' },
  );

export const BrowserTypeArgsSchema = z.object({
  selector: z.string().min(1),
  text: z.string(),
});

export const BrowserPressKeyArgsSchema = z.object({
  key: z.string().min(1),
});

export const BrowserEvaluateArgsSchema = z.object({
  js: z.string().min(1),
});

export const BrowserConsoleMessagesArgsSchema = z
  .object({
    level: z
      .enum(['log', 'info', 'warn', 'error', 'debug'])
      .optional(),
  })
  .strict();

export const BrowserReloadArgsSchema = z.object({}).strict();

export type BrowserNavigateArgs = z.infer<typeof BrowserNavigateArgsSchema>;
export type BrowserClickArgs = z.infer<typeof BrowserClickArgsSchema>;
export type BrowserTypeArgs = z.infer<typeof BrowserTypeArgsSchema>;
export type BrowserPressKeyArgs = z.infer<typeof BrowserPressKeyArgsSchema>;
export type BrowserEvaluateArgs = z.infer<typeof BrowserEvaluateArgsSchema>;
export type BrowserConsoleMessagesArgs = z.infer<
  typeof BrowserConsoleMessagesArgsSchema
>;

// ---------- Helpers ----------

const EVALUATE_MAX_BYTES = 8 * 1024;

function ok(output: string): ToolResult {
  return { success: true, output };
}

function fail(message: string): ToolResult {
  return { success: false, output: '', error: message };
}

function safeJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[…truncated at ${max} bytes]`;
}

function levelTag(e: BrowserConsoleEvent): string {
  return `[${e.level}]`;
}

// ---------- Tool handler factory ----------

/**
 * Build the eight browser tool handlers wired to a single shared
 * `BrowserSession`. The session is lazily started on the first call.
 *
 * The returned map matches the existing `ToolHandlerMap` shape used in
 * `createToolHandlerMap` (each entry has `preview`; none have `commit`
 * because none mutate the file system).
 */
export function createBrowserToolHandlers(
  session: BrowserSession,
): Record<
  string,
  {
    preview: (
      args: unknown,
      ctx: ToolContext,
    ) => Promise<ToolResult>;
  }
> {
  return {
    browser_navigate: {
      preview: async (args) => {
        const parsed = BrowserNavigateArgsSchema.safeParse(args);
        if (!parsed.success) return fail(zodMessage(parsed.error));
        try {
          const r = await session.navigate(parsed.data.url);
          return ok(`Navigated to ${r.url} — title: ${r.title}`);
        } catch (err) {
          return fail(errorMessage(err));
        }
      },
    },
    browser_screenshot: {
      preview: async (args) => {
        const parsed = BrowserScreenshotArgsSchema.safeParse(args);
        if (!parsed.success) return fail(zodMessage(parsed.error));
        try {
          const shot = await session.screenshot();
          // Match the `fetch_image` multimodal envelope so the adapter
          // can splice this into a vision-capable request.
          const envelope = {
            kind: 'image' as const,
            mimeType: 'image/png',
            dataBase64: shot.pngBase64,
            byteLength: Math.floor((shot.pngBase64.length * 3) / 4),
            description: `Screenshot ${shot.width}x${shot.height}`,
          };
          return { success: true, output: JSON.stringify(envelope) };
        } catch (err) {
          return fail(errorMessage(err));
        }
      },
    },
    browser_click: {
      preview: async (args) => {
        const parsed = BrowserClickArgsSchema.safeParse(args);
        if (!parsed.success) return fail(zodMessage(parsed.error));
        try {
          await session.click(parsed.data);
          if (typeof parsed.data.selector === 'string') {
            return ok(`Clicked ${parsed.data.selector}`);
          }
          return ok(`Clicked at (${parsed.data.x}, ${parsed.data.y})`);
        } catch (err) {
          return fail(errorMessage(err));
        }
      },
    },
    browser_type: {
      preview: async (args) => {
        const parsed = BrowserTypeArgsSchema.safeParse(args);
        if (!parsed.success) return fail(zodMessage(parsed.error));
        try {
          await session.type(parsed.data);
          return ok(
            `Typed ${parsed.data.text.length} chars into ${parsed.data.selector}`,
          );
        } catch (err) {
          return fail(errorMessage(err));
        }
      },
    },
    browser_press_key: {
      preview: async (args) => {
        const parsed = BrowserPressKeyArgsSchema.safeParse(args);
        if (!parsed.success) return fail(zodMessage(parsed.error));
        try {
          await session.pressKey(parsed.data.key);
          return ok(`Pressed ${parsed.data.key}`);
        } catch (err) {
          return fail(errorMessage(err));
        }
      },
    },
    browser_evaluate: {
      preview: async (args) => {
        const parsed = BrowserEvaluateArgsSchema.safeParse(args);
        if (!parsed.success) return fail(zodMessage(parsed.error));
        try {
          const r = await session.evaluate(parsed.data.js);
          return ok(truncate(safeJson(r.result), EVALUATE_MAX_BYTES));
        } catch (err) {
          return fail(errorMessage(err));
        }
      },
    },
    browser_console_messages: {
      preview: async (args) => {
        const parsed = BrowserConsoleMessagesArgsSchema.safeParse(args);
        if (!parsed.success) return fail(zodMessage(parsed.error));
        const all = session.consoleMessages();
        const filtered =
          parsed.data.level === undefined
            ? all
            : all.filter((m) => m.level === parsed.data.level);
        if (filtered.length === 0) {
          return ok('(no console messages)');
        }
        const dump = filtered
          .map((m) => `${levelTag(m)} ${m.text}`)
          .join('\n');
        return ok(truncate(dump, EVALUATE_MAX_BYTES));
      },
    },
    browser_reload: {
      preview: async (args) => {
        const parsed = BrowserReloadArgsSchema.safeParse(args);
        if (!parsed.success) return fail(zodMessage(parsed.error));
        try {
          const r = await session.reload();
          return ok(`Reloaded — ${r.url}`);
        } catch (err) {
          return fail(errorMessage(err));
        }
      },
    },
  };
}

/**
 * Convenience: spin up a session AND return its handler map. The session
 * itself is returned so the caller (app.tsx, the web runtime) can also
 * subscribe to events and forward them to subscribers.
 */
export function createBrowserToolBundle(opts: BrowserSessionOptions = {}): {
  session: BrowserSession;
  handlers: ReturnType<typeof createBrowserToolHandlers>;
} {
  const session = createBrowserSession(opts);
  return { session, handlers: createBrowserToolHandlers(session) };
}

// ---------- Internals ----------

function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join('; ');
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
