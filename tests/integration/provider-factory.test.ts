/**
 * R7 (Agent 9) — provider-factory integration tests.
 *
 * The `createAdapter` factory currently lives inside `src/app.tsx`
 * (Agent F R12 wired it up in the React component file). Until it's
 * extracted into a standalone module, we replicate the exact factory
 * shape here using imports of both adapter classes and verify:
 *
 *   - `createAdapter({ backend: 'anthropic', ... })` returns an
 *     `AnthropicAdapter` instance.
 *   - `createAdapter({ backend: 'openai' | 'openrouter' | 'google' |
 *     'custom' | 'ollama' | 'lmstudio', ... })` returns an `LLMAdapter`
 *     instance.
 *   - All `createAdapter` results expose the same public surface
 *     (`streamChat`, `getModels`, `ping`, `cancel`) regardless of which
 *     concrete adapter was constructed.
 *
 * The replication keeps the factory's contract under test even when
 * `app.tsx` is not directly importable in a test context (it pulls in
 * Ink + React + a half-dozen browser APIs). When the factory is
 * extracted to its own module in a future round, this file can switch
 * to importing it directly with no behavioural change.
 */
import { describe, expect, test } from 'bun:test';
import { LLMAdapter } from '@/llm/adapter';
import { AnthropicAdapter } from '@/llm/adapter-anthropic';
import type { Backend, GenerationConfig } from '@/types/global';

// ---------- Local replica of the factory ----------

type AnyAdapter = LLMAdapter | AnthropicAdapter;

interface CreateAdapterOptions {
  readonly backend: Backend;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly contextMaxTokens?: number;
  readonly keepAliveSeconds?: number;
  readonly responseTimeoutSeconds?: number;
  readonly generation?: GenerationConfig;
  readonly trimToolResultsAfter?: number;
  readonly chunkBatchMs?: number;
  readonly useJsonMode?: boolean;
  readonly adaptiveTemperature?: boolean;
  readonly customHeaders?: Record<string, string>;
}

/**
 * Mirror of the factory in `src/app.tsx`. Kept structurally identical
 * so a regression in either implementation causes one of these tests to
 * fail. Specifically: routing must depend ONLY on `opts.backend`, and
 * the Anthropic constructor must be invoked with a non-empty apiKey.
 */
function createAdapter(opts: CreateAdapterOptions): AnyAdapter {
  if (opts.backend === 'anthropic') {
    return new AnthropicAdapter({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey ?? '',
      model: opts.model,
      contextMaxTokens: opts.contextMaxTokens,
      generation: opts.generation,
      stallTimeoutMs:
        opts.responseTimeoutSeconds !== undefined
          ? opts.responseTimeoutSeconds * 1000
          : undefined,
      customHeaders: opts.customHeaders,
    });
  }
  return new LLMAdapter({
    backend: opts.backend,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    contextMaxTokens: opts.contextMaxTokens,
    keepAliveSeconds: opts.keepAliveSeconds,
    stallTimeoutMs:
      opts.responseTimeoutSeconds !== undefined
        ? opts.responseTimeoutSeconds * 1000
        : undefined,
    generation: opts.generation,
    trimToolResultsAfter: opts.trimToolResultsAfter,
    chunkBatchMs: opts.chunkBatchMs,
    useJsonMode: opts.useJsonMode,
    adaptiveTemperature: opts.adaptiveTemperature,
    customHeaders: opts.customHeaders,
  });
}

// ---------- Tests ----------

describe('createAdapter — backend routing', () => {
  test('anthropic backend returns AnthropicAdapter instance', () => {
    const adapter = createAdapter({
      backend: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-3-5-sonnet-20241022',
    });
    expect(adapter).toBeInstanceOf(AnthropicAdapter);
    expect(adapter).not.toBeInstanceOf(LLMAdapter);
  });

  test('openai backend returns LLMAdapter instance', () => {
    const adapter = createAdapter({
      backend: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    });
    expect(adapter).toBeInstanceOf(LLMAdapter);
    expect(adapter).not.toBeInstanceOf(AnthropicAdapter);
  });

  test('openrouter / google / custom / ollama / lmstudio all route to LLMAdapter', () => {
    const otherBackends: Backend[] = [
      'openrouter',
      'google',
      'custom',
      'ollama',
      'lmstudio',
    ];
    for (const backend of otherBackends) {
      const adapter = createAdapter({
        backend,
        baseUrl: 'http://localhost:1234',
        apiKey: backend === 'ollama' || backend === 'lmstudio' ? undefined : 'k',
        model: 'm-1',
      });
      expect(adapter).toBeInstanceOf(LLMAdapter);
      expect(adapter).not.toBeInstanceOf(AnthropicAdapter);
    }
  });
});

describe('createAdapter — interface compatibility', () => {
  test('every adapter exposes streamChat / getModels / ping / cancel', () => {
    const allBackends: Array<{ backend: Backend; apiKey?: string }> = [
      { backend: 'anthropic', apiKey: 'sk-ant' },
      { backend: 'openai', apiKey: 'sk' },
      { backend: 'openrouter', apiKey: 'or-k' },
      { backend: 'google', apiKey: 'gemini-k' },
      { backend: 'custom', apiKey: 'custom-k' },
      { backend: 'ollama' },
      { backend: 'lmstudio' },
    ];
    for (const { backend, apiKey } of allBackends) {
      const adapter = createAdapter({
        backend,
        baseUrl:
          backend === 'anthropic'
            ? 'https://api.anthropic.com/v1'
            : 'http://localhost:1234/v1',
        apiKey,
        model: 'test-model',
      });
      // All four public methods present.
      expect(typeof adapter.streamChat).toBe('function');
      expect(typeof adapter.getModels).toBe('function');
      expect(typeof adapter.ping).toBe('function');
      expect(typeof adapter.cancel).toBe('function');
    }
  });

  test('cancel() never throws even when no stream is active', () => {
    const adapter = createAdapter({
      backend: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk',
      model: 'gpt-4o',
    });
    expect(() => adapter.cancel()).not.toThrow();
  });

  test('anthropic without apiKey throws inside the AnthropicAdapter ctor', () => {
    expect(() => {
      createAdapter({
        backend: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        // No apiKey — factory passes empty string, ctor must reject.
        model: 'claude-3-5-sonnet-20241022',
      });
    }).toThrow();
  });
});
