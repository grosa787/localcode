/**
 * Skills management screen.
 *
 * Modes:
 *   'list'   (default)   — browse + toggle + delete
 *   'add'                — text input for a file path to import
 *
 * Hotkeys (list):
 *   ↑/↓     navigate
 *   space   toggle active
 *   a       enter `add` mode
 *   d       delete currently-selected skill
 *   Esc     onBack()
 *
 * Hotkeys (add):
 *   Enter   submit path (calls onAdd)
 *   Esc     cancel → back to list
 */

import React, { useCallback, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import { theme } from '../theme.js';
import type { Skill } from '../../types/global.js';

export interface SkillsScreenProps {
  readonly skills: readonly Skill[];
  readonly onToggle: (id: string) => void;
  readonly onAdd: (path: string) => Promise<void>;
  readonly onDelete: (id: string) => void;
  readonly onBack: () => void;
}

type Mode = 'list' | 'add';

function SkillsScreen({
  skills,
  onToggle,
  onAdd,
  onDelete,
  onBack,
}: SkillsScreenProps): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('list');
  const [index, setIndex] = useState<number>(0);
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState<boolean>(false);
  const [pathDraft, setPathDraft] = useState<string>('');

  const clamp = useCallback(
    (i: number) => {
      if (skills.length <= 0) return 0;
      if (i < 0) return skills.length - 1;
      if (i >= skills.length) return 0;
      return i;
    },
    [skills.length],
  );

  const handleListInput = useCallback(
    (
      input: string,
      key: { upArrow?: boolean; downArrow?: boolean; escape?: boolean },
    ): void => {
      if (key.escape) {
        onBack();
        return;
      }
      if (key.upArrow) {
        setIndex((i) => clamp(i - 1));
        return;
      }
      if (key.downArrow) {
        setIndex((i) => clamp(i + 1));
        return;
      }
      if (input === ' ') {
        const current = skills[index];
        if (current !== undefined) onToggle(current.id);
        return;
      }
      const lower = input.toLowerCase();
      if (lower === 'a') {
        setMode('add');
        setPathDraft('');
        setAddError(null);
        return;
      }
      if (lower === 'd') {
        const current = skills[index];
        if (current !== undefined) {
          onDelete(current.id);
          // Move the cursor up if we deleted the last item.
          if (index >= skills.length - 1) {
            setIndex(Math.max(0, skills.length - 2));
          }
        }
        return;
      }
    },
    [clamp, index, onBack, onDelete, onToggle, skills],
  );

  const handleAddInput = useCallback(
    (_input: string, key: { escape?: boolean }) => {
      if (key.escape) {
        setMode('list');
        setAddError(null);
      }
    },
    [],
  );

  useInput(mode === 'list' ? handleListInput : handleAddInput);

  const handleAddSubmit = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        setAddError('Path cannot be empty.');
        return;
      }
      setAddBusy(true);
      setAddError(null);
      try {
        await onAdd(trimmed);
        setMode('list');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setAddError(msg);
      } finally {
        setAddBusy(false);
      }
    },
    [onAdd],
  );

  if (mode === 'add') {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text bold>{theme.logo}</Text>
        <Box marginTop={1}>
          <Text>Add skill — enter a file path to import:</Text>
        </Box>
        <Box>
          <Text>{theme.prompt} </Text>
          {addBusy ? (
            <Text color="gray">working…</Text>
          ) : (
            <TextInput
              defaultValue={pathDraft}
              placeholder="~/snippets/my-skill.md"
              onChange={setPathDraft}
              onSubmit={(v) => {
                void handleAddSubmit(v);
              }}
            />
          )}
        </Box>
        {addError !== null && (
          <Box marginTop={1}>
            <Text color="red">⚠ {addError}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color="gray">Enter to import · Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold>{theme.logo}</Text>
      <Box marginTop={1}>
        <Text>Skills ({skills.length}):</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {skills.length === 0 ? (
          <Text color="gray">(no skills yet — press `a` to add one)</Text>
        ) : (
          skills.map((s, i) => {
            const active = i === index;
            const mark = s.active ? '✓' : '✗';
            const markColor = s.active ? 'green' : 'red';
            const nameColor = active ? 'green' : 'white';
            return (
              <Box key={s.id} flexDirection="row">
                <Text color={nameColor}>{active ? '❯ ' : '  '}</Text>
                <Text color={markColor}>{mark}</Text>
                <Text color={nameColor}> {s.name}</Text>
                {s.description.length > 0 && (
                  <Text color="gray">  — {s.description}</Text>
                )}
              </Box>
            );
          })
        )}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          ↑/↓ navigate · space toggle · a add · d delete · Esc back
        </Text>
      </Box>
    </Box>
  );
}

export default SkillsScreen;
