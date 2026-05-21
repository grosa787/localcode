/**
 * MermaidBlock — verifies:
 *   1. The mermaid library is lazy-loaded only on first mount.
 *   2. Successful render injects the returned SVG into the DOM.
 *   3. Render error path produces the "Invalid Mermaid" fallback.
 *   4. Theme switching re-invokes mermaid.initialize with the new theme.
 *   5. Markdown dispatch routes ```mermaid blocks to MermaidBlock.
 */

import { cleanup, render, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Mock the heavyweight mermaid module so the test never actually
// downloads / parses anything. Each test customises the resolved value
// via the spies below.
const initializeSpy = vi.fn();
const renderSpy = vi.fn();

vi.mock('mermaid', () => ({
  default: {
    initialize: (...args: unknown[]) => initializeSpy(...args),
    render: (...args: unknown[]) => renderSpy(...args),
  },
}));

import { MermaidBlock } from './MermaidBlock';
import { Markdown } from '../util/markdown';

afterEach(() => {
  cleanup();
  initializeSpy.mockReset();
  renderSpy.mockReset();
});

beforeEach(() => {
  // Default: successful render returns a simple SVG.
  renderSpy.mockResolvedValue({ svg: '<svg data-testid="injected"></svg>' });
});

describe('MermaidBlock', () => {
  test('lazy-loads mermaid and injects rendered SVG', async () => {
    const { container, getByTestId } = render(
      <MermaidBlock code="flowchart TB\nA --> B" />,
    );
    // Pending placeholder appears synchronously.
    expect(getByTestId('mermaid-pending')).toBeTruthy();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="mermaid-block"]')).not.toBeNull();
    });
    expect(initializeSpy).toHaveBeenCalled();
    expect(renderSpy).toHaveBeenCalled();
    // SVG payload landed in the DOM.
    expect(container.querySelector('[data-testid="injected"]')).not.toBeNull();
  });

  test('shows error fallback when mermaid.render throws', async () => {
    renderSpy.mockRejectedValueOnce(new Error('parse blew up'));
    const { container, getByTestId } = render(
      <MermaidBlock code="not actually mermaid" />,
    );
    await waitFor(() => {
      expect(getByTestId('mermaid-error')).toBeTruthy();
    });
    expect(container.textContent).toContain('Invalid Mermaid');
    expect(container.textContent).toContain('not actually mermaid');
  });

  test('theme switch triggers a re-render', async () => {
    // Start in light mode.
    document.documentElement.dataset['theme'] = 'light';
    const { container } = render(<MermaidBlock code="flowchart TB\nA --> B" />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="mermaid-block"]')).not.toBeNull();
    });
    const firstCallTheme = initializeSpy.mock.calls[0]?.[0]?.theme;
    expect(firstCallTheme).toBe('default');

    // Switch to dark — MutationObserver should fire.
    act(() => {
      document.documentElement.dataset['theme'] = 'dark';
    });
    await waitFor(() => {
      // mermaid.initialize was called again with theme: dark.
      const themes = initializeSpy.mock.calls.map((c) => c[0]?.theme);
      expect(themes.includes('dark')).toBe(true);
    });
  });
});

describe('Markdown — mermaid dispatch', () => {
  test('```mermaid block routes to MermaidBlock', async () => {
    const src = '```mermaid\nflowchart TB\nA --> B\n```';
    const { container } = render(<Markdown source={src} />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="mermaid-block"]')).not.toBeNull();
    });
    // The plain SyntaxBlock should NOT appear for mermaid fences (it
    // would have rendered the language label "mermaid" inside its own
    // header span — instead we expect the MermaidBlock label).
    const headers = container.querySelectorAll('div');
    const hasSyntaxLabel = Array.from(headers).some(
      (h) => h.className.includes('lang') && h.textContent === 'mermaid',
    );
    expect(hasSyntaxLabel).toBe(false);
  });

  test('non-mermaid fences still go to SyntaxBlock', () => {
    const src = '```typescript\nconst x = 1;\n```';
    const { container } = render(<Markdown source={src} />);
    expect(container.querySelector('[data-testid="mermaid-block"]')).toBeNull();
    expect(container.textContent).toContain('const x = 1;');
  });
});
