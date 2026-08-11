/**
 * slash-executor — `/provider unsloth` carries the --disable-tools note.
 *
 * Unsloth Studio runs its own tool loop unless launched with
 * `--disable-tools`, swallowing the tool calls LocalCode depends on.
 * Nothing errors — the model just appears to do nothing — so the note
 * must be attached at switch time, and in the user's language.
 */

import { describe, expect, test } from 'vitest';

import { en } from '../i18n/en';
import { ru } from '../i18n/ru';
import {
  executeSlashCommand,
  type SlashExecCtx,
  type SlashRestSurface,
} from './slash-executor';

function makeCtx(locale?: 'en' | 'ru'): SlashExecCtx {
  const rest = {
    setProvider: async () => ({
      ok: true as const,
      backend: 'unsloth' as const,
      baseUrl: 'http://localhost:8888/v1',
      models: ['unsloth/qwen3-coder-GGUF'],
      currentModel: 'unsloth/qwen3-coder-GGUF',
    }),
  } as unknown as SlashRestSurface;
  return {
    rest,
    store: {
      openOverlay: () => {},
      setActiveSession: () => {},
      clearSessionMessages: () => {},
      pushToast: () => {},
    },
    sessionId: null,
    projectId: null,
    backend: null,
    model: null,
    commands: [],
    ...(locale !== undefined ? { locale } : {}),
  };
}

describe('/provider unsloth', () => {
  test('appends the --disable-tools note (default English)', async () => {
    const res = await executeSlashCommand('/provider unsloth', makeCtx());
    expect(res.kind).toBe('config-changed');
    expect(res.text).toContain('--disable-tools');
    expect(res.text).toContain(en['provider.unsloth.disableTools.body']);
  });

  test('the note is localised, not hardcoded English', async () => {
    const res = await executeSlashCommand('/provider unsloth', makeCtx('ru'));
    expect(res.text).toContain(ru['provider.unsloth.disableTools.body']);
    expect(res.text).not.toContain(en['provider.unsloth.disableTools.body']);
  });

  test('other providers get no unsloth note', async () => {
    const ctx = makeCtx();
    const rest = {
      setProvider: async () => ({
        ok: true as const,
        backend: 'ollama' as const,
        baseUrl: 'http://localhost:11434',
        models: ['llama3'],
        currentModel: 'llama3',
      }),
    } as unknown as SlashRestSurface;
    const res = await executeSlashCommand('/provider ollama', { ...ctx, rest });
    expect(res.text).not.toContain('--disable-tools');
  });
});
