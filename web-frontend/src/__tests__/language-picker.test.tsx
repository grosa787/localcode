/**
 * LanguagePicker (web) — first-launch modal.
 *
 * Covers:
 *   - Renders both flag rows.
 *   - Clicking a row fires onSelect with the matching locale.
 *   - Title + subtitle copy match the active locale (no flash of EN
 *     before RU on a stored-RU profile).
 *   - Arrow + Enter keyboard flow confirms via onSelect.
 */
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { JSX } from 'react';

import { LanguagePicker } from '../components/LanguagePicker';
import { useStore } from '../state/store';

function mount(onSelect: (l: 'en' | 'ru') => void): JSX.Element {
  return <LanguagePicker onSelect={onSelect} />;
}

beforeEach(() => {
  // Reset locale to a known default before each test so cross-test
  // bleed doesn't affect copy / highlight assertions.
  useStore.getState().setLocale('en');
});

describe('LanguagePicker (web)', () => {
  test('renders both rows with flag emojis + labels', () => {
    render(mount(() => undefined));
    expect(screen.getByTestId('language-row-en')).toBeTruthy();
    expect(screen.getByTestId('language-row-ru')).toBeTruthy();
    // Labels are i18n-driven; English bucket says "English" and "Русский".
    expect(screen.getByText('English')).toBeTruthy();
    expect(screen.getByText('Русский')).toBeTruthy();
  });

  test('clicking the English row fires onSelect with "en"', () => {
    const onSelect = vi.fn();
    render(mount(onSelect));
    fireEvent.click(screen.getByTestId('language-row-en'));
    expect(onSelect).toHaveBeenCalledWith('en');
  });

  test('clicking the Russian row fires onSelect with "ru"', () => {
    const onSelect = vi.fn();
    render(mount(onSelect));
    fireEvent.click(screen.getByTestId('language-row-ru'));
    expect(onSelect).toHaveBeenCalledWith('ru');
  });

  test('Continue button confirms the active row', () => {
    const onSelect = vi.fn();
    render(mount(onSelect));
    // Default highlight = the active locale row, set above to 'en'.
    fireEvent.click(screen.getByTestId('language-confirm'));
    expect(onSelect).toHaveBeenCalledWith('en');
  });

  test('ArrowDown then Enter selects the next row', () => {
    const onSelect = vi.fn();
    render(mount(onSelect));
    const enRow = screen.getByTestId('language-row-en');
    act(() => {
      enRow.focus();
    });
    fireEvent.keyDown(enRow, { key: 'ArrowDown' });
    // After arrow-down the Russian row is active; pressing Enter on the
    // English row still confirms whichever index is active inside the
    // picker.
    fireEvent.keyDown(enRow, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('ru');
  });

  test('no flash of EN copy when initial locale is RU', () => {
    // Pre-set the store to Russian BEFORE rendering. The picker must
    // pick up the Russian copy on its very first render — no flash of
    // English title/subtitle.
    useStore.getState().setLocale('ru');
    render(mount(() => undefined));
    // Subtitle text reflects the active locale immediately on first paint.
    expect(screen.getByText('Выберите язык')).toBeTruthy();
    // English subtitle MUST NOT be in the initial DOM snapshot.
    expect(screen.queryByText('Choose your language')).toBeNull();
  });

  test('dialog has aria-modal=true for accessibility', () => {
    render(mount(() => undefined));
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });
});
