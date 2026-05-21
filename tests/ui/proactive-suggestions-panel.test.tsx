/**
 * ProactiveSuggestionsPanel tests.
 *
 * Covers:
 *   - Renders one suggestion when visible and suggestion is present.
 *   - Renders nothing when invisible.
 *   - Renders nothing when no suggestion is supplied.
 *   - Uses the host-supplied hotkey label.
 */

import { describe, expect, test } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';

import ProactiveSuggestionsPanel from '@/ui/components/ProactiveSuggestionsPanel';
import type { ProactiveSuggestion } from '@/agents/proactive-detector';

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

interface MountResult {
  readonly read: () => string;
  readonly unmount: () => void;
}

function mountPanel(props: {
  readonly suggestion?: ProactiveSuggestion | null;
  readonly visible: boolean;
  readonly hotkeyLabel?: string;
}): MountResult {
  const buf: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb): void {
      buf.push(Buffer.from(chunk));
      cb();
    },
  });
  (stdout as unknown as { columns: number }).columns = 200;
  (stdout as unknown as { rows: number }).rows = 40;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  const instance = render(
    React.createElement(ProactiveSuggestionsPanel, props),
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stdout: stdout as any,
      debug: true,
      exitOnCtrlC: false,
    },
  );

  return {
    read: () => stripAnsi(Buffer.concat(buf).toString('utf8')),
    unmount: () => instance.unmount(),
  };
}

function makeSuggestion(): ProactiveSuggestion {
  return {
    id: 'debugger-abc123',
    templateId: 'debugger',
    reason: 'Looks like you are debugging — spawn debugger agent?',
    confidence: 0.85,
  };
}

describe('ProactiveSuggestionsPanel', () => {
  test('renders the single suggestion when visible', () => {
    const m = mountPanel({ visible: true, suggestion: makeSuggestion() });
    const out = m.read();
    m.unmount();
    expect(out).toContain('💡');
    expect(out).toContain('Looks like you are debugging');
    expect(out).toContain('Ctrl+Shift+D');
  });

  test('renders nothing when visible is false', () => {
    const m = mountPanel({ visible: false, suggestion: makeSuggestion() });
    const out = m.read();
    m.unmount();
    expect(out).not.toContain('debugging');
    expect(out).not.toContain('💡');
  });

  test('renders nothing when suggestion is null', () => {
    const m = mountPanel({ visible: true, suggestion: null });
    const out = m.read();
    m.unmount();
    expect(out).not.toContain('💡');
  });

  test('renders nothing when suggestion is undefined', () => {
    const m = mountPanel({ visible: true });
    const out = m.read();
    m.unmount();
    expect(out).not.toContain('💡');
  });

  test('uses a custom hotkey label when supplied', () => {
    const m = mountPanel({
      visible: true,
      suggestion: makeSuggestion(),
      hotkeyLabel: 'Ctrl+T',
    });
    const out = m.read();
    m.unmount();
    expect(out).toContain('Ctrl+T');
    expect(out).not.toContain('Ctrl+Shift+D');
  });

  test('renders a different suggestion correctly', () => {
    const suggestion: ProactiveSuggestion = {
      id: 'perf-xyz',
      templateId: 'performance-optimizer',
      reason: 'Sounds like a perf concern — spawn performance-optimizer agent?',
      confidence: 0.7,
    };
    const m = mountPanel({ visible: true, suggestion });
    const out = m.read();
    m.unmount();
    expect(out).toContain('perf concern');
    expect(out).toContain('performance-optimizer');
  });
});
