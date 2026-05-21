/**
 * QueueIndicator — renders count chip, opens dropdown listing each
 * queued message, per-item delete invokes dequeueMessage, clear-all
 * invokes clearPendingQueue, and long content is truncated to the
 * preview limit.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { QueueIndicator, truncatePreview } from './QueueIndicator';
import { useStore } from '../state/store';

afterEach(() => cleanup());

beforeEach(() => {
  useStore.getState().clearPendingQueue();
});

function seed(contents: string[]): void {
  for (const c of contents) {
    useStore.getState().enqueueMessage(c);
  }
}

describe('QueueIndicator', () => {
  test('renders nothing when count is 0', () => {
    const { container } = render(<QueueIndicator count={0} />);
    expect(container.firstChild).toBeNull();
  });

  test('shows singular label for a single queued item', () => {
    seed(['hello']);
    render(<QueueIndicator count={1} />);
    // getByRole / getByText throw when not found — wrap in expect for
    // intent, matching the existing test idioms in this repo (no
    // @testing-library/jest-dom matchers are configured).
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText(/1 message queued/i)).toBeTruthy();
  });

  test('shows pluralised label with the count interpolated', () => {
    seed(['a', 'b', 'c']);
    render(<QueueIndicator count={3} />);
    expect(screen.getByText(/3 messages queued/i)).toBeTruthy();
  });

  test('dropdown opens on summary click and lists each queued message', () => {
    seed(['first', 'second', 'third']);
    render(<QueueIndicator count={3} />);
    // Listbox is not present until the user opens the dropdown.
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /show queued/i }));
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[0]?.textContent ?? '').toContain('first');
    expect(options[1]?.textContent ?? '').toContain('second');
    expect(options[2]?.textContent ?? '').toContain('third');
  });

  test('per-item delete removes only that item from the store', () => {
    seed(['keep', 'drop', 'keep-too']);
    render(<QueueIndicator count={3} />);
    fireEvent.click(screen.getByRole('button', { name: /show queued/i }));
    const deleteButtons = screen.getAllByRole('button', {
      name: /remove queued message/i,
    });
    expect(deleteButtons).toHaveLength(3);
    // Delete the middle one.
    fireEvent.click(deleteButtons[1] as HTMLElement);
    const remaining = useStore.getState().pendingQueue.map((it) => it.content);
    expect(remaining).toEqual(['keep', 'keep-too']);
  });

  test('clear button empties the queue', () => {
    seed(['a', 'b']);
    render(<QueueIndicator count={2} />);
    fireEvent.click(screen.getByRole('button', { name: /clear queued messages/i }));
    expect(useStore.getState().pendingQueue).toHaveLength(0);
  });
});

describe('truncatePreview', () => {
  test('returns content unchanged when within line limit', () => {
    expect(truncatePreview('one\ntwo\nthree')).toBe('one\ntwo\nthree');
  });

  test('keeps first N lines and appends ellipsis when over limit', () => {
    const long = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n');
    const out = truncatePreview(long, 5);
    expect(out.endsWith('…')).toBe(true);
    expect(out.split('\n')).toHaveLength(5);
    expect(out.startsWith('l1\nl2\nl3\nl4')).toBe(true);
  });

  test('respects the explicit max parameter', () => {
    expect(truncatePreview('a\nb\nc\nd', 2)).toBe('a\nb…');
  });
});
