/**
 * MESSAGE-COST-CHIP-SECTION — chip render rules.
 *
 *   - chip renders when `cost > 0` is supplied (with model + tokens).
 *   - chip is hidden when `cost === 0` AND no other telemetry fields.
 *   - chip is hidden while `streaming` is true (mid-stream telemetry
 *     is still incoming and the chip would flicker).
 */

import { describe, expect, test, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { AssistantMessage } from './AssistantMessage';

afterEach(() => {
  cleanup();
});

describe('AssistantMessage — cost chip', () => {
  test('renders chip when cost > 0', () => {
    // Value above the half-cent threshold so the chip renders the
    // formatted amount rather than collapsing to "$0.00".
    render(
      <AssistantMessage
        model="gpt-4o-mini"
        content="hello"
        cost={0.0234}
        tokensInput={10_000}
        tokensOutput={5_000}
        durationMs={1500}
      />,
    );
    const chip = screen.getByTestId('assistant-cost-chip');
    expect(chip).toBeDefined();
    expect(chip.textContent ?? '').toContain('gpt-4o-mini');
    expect(chip.textContent ?? '').toContain('$0.0234');
    expect(chip.textContent ?? '').toContain('10.0k in');
    expect(chip.textContent ?? '').toContain('5.0k out');
    expect(chip.textContent ?? '').toContain('1.5s');
  });

  test('hidden when cost is zero AND no other telemetry', () => {
    render(
      <AssistantMessage
        model="gpt-4o-mini"
        content="hello"
        cost={0}
      />,
    );
    expect(screen.queryByTestId('assistant-cost-chip')).toBeNull();
  });

  test('hidden when streaming, even with cost present', () => {
    render(
      <AssistantMessage
        model="gpt-4o-mini"
        content="hello"
        cost={0.0045}
        tokensInput={10_000}
        streaming={true}
      />,
    );
    expect(screen.queryByTestId('assistant-cost-chip')).toBeNull();
  });

  test('renders chip when only token counts are present (no cost)', () => {
    // Local-provider rows have no cost but still show token counts.
    render(
      <AssistantMessage
        model="qwen2.5-coder"
        content="hello"
        tokensInput={1_000}
        tokensOutput={500}
      />,
    );
    const chip = screen.getByTestId('assistant-cost-chip');
    expect(chip.textContent ?? '').toContain('qwen2.5-coder');
    expect(chip.textContent ?? '').toContain('1.0k in');
    expect(chip.textContent ?? '').not.toContain('$');
  });
});
