/**
 * First-launch language picker.
 *
 * Shown on the very first run (when `config.locale` is undefined) BEFORE
 * the existing backend / URL / model onboarding. Also re-opened later
 * via the `/language` slash command without arguments.
 *
 * The picker is a single, focused screen — two rows (English / Russian),
 * arrow-key navigation, Enter to confirm. The selected row is rendered
 * with the existing Nox accent so it matches the rest of the TUI.
 */

import React, { useCallback, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Locale } from '../../types/global.js';
import { noxPalette, textMuted } from '../theme.js';
import { NoxBig } from '../components/Nox.js';

export interface LanguagePickerProps {
  /**
   * Called when the user confirms a language. The parent is responsible
   * for persisting the choice (e.g. via ConfigManager.update) and
   * advancing to the next screen.
   */
  readonly onSelect: (locale: Locale) => void;
  /**
   * Optional initial highlighted row. When omitted, defaults to `'en'`.
   * Used by `/language` (no-args) re-opens to pre-highlight the current
   * locale.
   */
  readonly initial?: Locale;
}

interface Choice {
  readonly id: Locale;
  readonly flag: string;
  readonly label: string;
}

const CHOICES: readonly Choice[] = [
  { id: 'en', flag: '🇬🇧', label: 'English' },
  { id: 'ru', flag: '🇷🇺', label: 'Русский' },
];

function LanguagePicker({
  onSelect,
  initial = 'en',
}: LanguagePickerProps): React.JSX.Element {
  const [index, setIndex] = useState<number>(() => {
    const i = CHOICES.findIndex((c) => c.id === initial);
    return i < 0 ? 0 : i;
  });

  const moveUp = useCallback(() => {
    setIndex((i) => (i <= 0 ? CHOICES.length - 1 : i - 1));
  }, []);
  const moveDown = useCallback(() => {
    setIndex((i) => (i >= CHOICES.length - 1 ? 0 : i + 1));
  }, []);

  useInput(
    useCallback(
      (
        _input: string,
        key: { upArrow?: boolean; downArrow?: boolean; return?: boolean },
      ) => {
        if (key.upArrow) {
          moveUp();
          return;
        }
        if (key.downArrow) {
          moveDown();
          return;
        }
        if (key.return) {
          const chosen = CHOICES[index];
          if (chosen === undefined) return;
          onSelect(chosen.id);
          return;
        }
      },
      [index, moveUp, moveDown, onSelect],
    ),
  );

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <NoxBig />
      <Box marginTop={1} flexDirection="column">
        <Text bold color={noxPalette.white}>
          Welcome to LocalCode / Добро пожаловать в LocalCode
        </Text>
        <Box marginTop={1}>
          <Text color={textMuted}>
            Choose your language / Выберите язык
          </Text>
        </Box>
      </Box>
      <Box flexDirection="column" marginTop={1} paddingX={1}>
        {CHOICES.map((c, i) => {
          const active = i === index;
          return (
            <Box key={c.id}>
              <Text
                color={active ? noxPalette.highlight : noxPalette.white}
                bold={active}
              >
                {active ? '▸  ' : '   '}
                {c.flag}
                {'  '}
                {c.label}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={textMuted}>
          ↑/↓ navigate · Enter to confirm
        </Text>
      </Box>
    </Box>
  );
}

export default LanguagePicker;
