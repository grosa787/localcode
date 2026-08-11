/**
 * ProviderPicker — Unsloth Studio specifics.
 *
 * Three invariants, all of which shipped broken once:
 *   1. `unsloth` still asks for an API key. "Runs on localhost" is NOT
 *      "needs no key" — grouping it with ollama/lmstudio 401s every
 *      request.
 *   2. The `--disable-tools` warning is actually RENDERED. Without the
 *      flag Unsloth answers tool calls itself and LocalCode looks
 *      frozen, so the copy has to reach the user before the first turn.
 *   3. That warning goes through i18n — a Russian-locale user must not
 *      get an English-only paragraph.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { useStore } from '../state/store';
import { en } from '../i18n/en';
import { ru } from '../i18n/ru';

import { ProviderPicker } from './ProviderPicker';

const initialState = useStore.getState();

beforeEach(() => {
  useStore.setState({ ...initialState, activeBackend: 'ollama', locale: 'en' });
});

afterEach(() => {
  cleanup();
});

function renderPicker(): void {
  render(<ProviderPicker onClose={() => {}} onSwitch={async () => {
    throw new Error('not used');
  }} />);
}

describe('ProviderPicker — unsloth', () => {
  test('offers Unsloth Studio as a row', () => {
    renderPicker();
    expect(screen.getByLabelText('Select Unsloth Studio (local)')).toBeDefined();
  });

  test('unsloth keeps the needs-key dot (local is not keyless)', () => {
    renderPicker();
    const row = screen.getByLabelText('Select Unsloth Studio (local)');
    const dot = row.querySelector('span[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    // Red = needsKey. CSS-module class names are hashed, so assert on the
    // stable substring the module preserves.
    expect(dot?.className).toContain('dotRed');
  });

  test('genuinely keyless local providers keep the green dot', () => {
    renderPicker();
    const row = screen.getByLabelText('Select LM Studio (local)');
    const dot = row.querySelector('span[aria-hidden="true"]');
    expect(dot?.className).toContain('dotGreen');
  });

  test('renders the --disable-tools warning from the i18n table', () => {
    renderPicker();
    expect(
      screen.getByText(en['provider.unsloth.disableTools.title']),
    ).toBeDefined();
    expect(
      screen.getByText(en['provider.unsloth.disableTools.command']),
    ).toBeDefined();
  });

  test('the warning follows the active locale', () => {
    useStore.setState({ locale: 'ru' });
    renderPicker();
    expect(
      screen.getByText(ru['provider.unsloth.disableTools.title']),
    ).toBeDefined();
    expect(
      screen.queryByText(en['provider.unsloth.disableTools.title']),
    ).toBeNull();
  });
});
