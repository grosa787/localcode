/**
 * TOOL-RENDERERS-SECTION — `Ctrl+O` ref-pick overlay.
 *
 * Self-contained overlay that subscribes to the `'input'` mode of the
 * shared `InputDispatcher`. When the user presses `Ctrl+O` and the
 * ambient `<RefRegistryProvider>` has at least one registered ref, the
 * overlay opens a numbered jump list of every file reference in the
 * current scope. Pressing a digit picks the entry and calls
 * `onJump(entry)`. Esc cancels.
 *
 * Mounting model: drop one of these inside a `<RefRegistryProvider>`
 * and pass an `onJump` callback. The component is otherwise invisible
 * — it only paints when open.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { noxPalette, textMuted, dimSeparator } from '../theme.js';
import { useInputModeHandler, type InputEvent } from './InputDispatcher.js';
import { useRefRegistry, type RefEntry } from '../hooks/useRefRegistry.js';

export interface RefPickOverlayProps {
  /** Called when the user picks an entry via digit key. */
  readonly onJump: (entry: RefEntry) => void;
  /**
   * When true, the open state is forced — useful for tests that want to
   * exercise the overlay's render path without sending a real keystroke.
   */
  readonly forceOpen?: boolean;
}

function digitFromInput(event: InputEvent): number | null {
  if (event.input.length !== 1) return null;
  const code = event.input.charCodeAt(0);
  if (code < 0x30 /* '0' */ || code > 0x39 /* '9' */) return null;
  return code - 0x30;
}

function RefPickOverlay({
  onJump,
  forceOpen,
}: RefPickOverlayProps): React.JSX.Element | null {
  const registry = useRefRegistry();
  const [open, setOpen] = useState<boolean>(forceOpen === true);
  // Buffer for multi-digit numbers (e.g. press `1` then `2` for ref 12
  // when there are >9 refs). Cleared on Esc / select / timeout.
  const [digits, setDigits] = useState<string>('');

  useEffect(() => {
    if (forceOpen === true) setOpen(true);
  }, [forceOpen]);

  const handle = useCallback(
    (event: InputEvent): boolean => {
      // Ctrl+O toggles the overlay.
      if (event.input === '' /* ^O */ || (event.key.ctrl && event.input === 'o')) {
        if (registry.size() === 0) return false;
        setOpen((prev) => !prev);
        setDigits('');
        return true;
      }
      if (!open) return false;
      if (event.key.escape) {
        setOpen(false);
        setDigits('');
        return true;
      }
      const digit = digitFromInput(event);
      if (digit !== null) {
        const next = digits + String(digit);
        const candidate = Number.parseInt(next, 10);
        const all = registry.snapshot();
        // If the candidate exactly matches an id AND no longer number
        // could match (next digit would exceed total), commit. Otherwise
        // hold the buffer to allow further digits.
        const max = all.length;
        const couldGrow = Number.parseInt(next + '0', 10) <= max;
        if (candidate >= 1 && candidate <= max && !couldGrow) {
          const picked = all.find((e) => e.id === candidate);
          if (picked !== undefined) onJump(picked);
          setOpen(false);
          setDigits('');
          return true;
        }
        if (couldGrow) {
          setDigits(next);
          return true;
        }
        // Invalid digit — clear buffer.
        setDigits('');
        return true;
      }
      // Swallow all other keys while open so the InputBar doesn't
      // see them (consistent with overlay/approval modes).
      return true;
    },
    [open, registry, digits, onJump],
  );

  useInputModeHandler('input', handle);

  if (!open) return null;
  const entries = registry.snapshot();
  if (entries.length === 0) return null;
  return (
    <Box
      flexDirection="column"
      paddingX={1}
      borderStyle="round"
      borderColor={dimSeparator}
      marginTop={1}
    >
      <Text color={noxPalette.highlight} bold>
        Pick a file reference
      </Text>
      <Box flexDirection="column" marginTop={0}>
        {entries.map((entry) => (
          <Box key={`rp-${entry.id}`} flexDirection="row">
            <Text color={textMuted}>{`${entry.id}. `}</Text>
            <Text color={noxPalette.light} underline>
              {entry.line !== undefined
                ? entry.column !== undefined
                  ? `${entry.path}:${entry.line}:${entry.column}`
                  : `${entry.path}:${entry.line}`
                : entry.path}
            </Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={0} flexDirection="row">
        <Text color={textMuted}>
          {digits.length > 0 ? `(buffer: ${digits}) ` : ''}
          Press digit to jump · Esc to cancel
        </Text>
      </Box>
    </Box>
  );
}

export default RefPickOverlay;
