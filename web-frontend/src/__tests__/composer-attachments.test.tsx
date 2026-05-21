/**
 * Composer multimodal helpers — presentational tests for the file
 * mention popup and image attachment preview. The Composer itself
 * depends on the App API-clients context and is exercised manually;
 * here we lock the building blocks the Composer wires together.
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  FileMentionAutocomplete,
  type FileMentionEntry,
} from '../components/FileMentionAutocomplete';
import {
  ImageAttachmentPreview,
  type ComposerImageAttachment,
} from '../components/ImageAttachmentPreview';

afterEach(() => cleanup());

const ENTRIES: FileMentionEntry[] = [
  { path: 'src/App.tsx', name: 'App.tsx', kind: 'file' },
  { path: 'src/components/Composer.tsx', name: 'Composer.tsx', kind: 'file' },
  { path: 'src', name: 'src', kind: 'dir' },
];

describe('FileMentionAutocomplete', () => {
  test('renders entries with parent path label', () => {
    const onPick = vi.fn();
    const { container } = render(
      <FileMentionAutocomplete
        entries={ENTRIES}
        selectedIndex={0}
        query=""
        loading={false}
        onPick={onPick}
      />,
    );
    const rows = container.querySelectorAll('[role="option"]');
    expect(rows.length).toBe(3);
    expect(container.textContent).toContain('Composer.tsx');
    expect(container.textContent).toContain('src/components');
  });

  test('selectedIndex highlights the active row', () => {
    const { container } = render(
      <FileMentionAutocomplete
        entries={ENTRIES}
        selectedIndex={1}
        query=""
        loading={false}
        onPick={vi.fn()}
      />,
    );
    const rows = container.querySelectorAll('[role="option"]');
    expect(rows[0]?.getAttribute('data-selected')).toBe('false');
    expect(rows[1]?.getAttribute('data-selected')).toBe('true');
  });

  test('mouseDown picks the entry (prevents focus loss)', () => {
    const onPick = vi.fn();
    const { container } = render(
      <FileMentionAutocomplete
        entries={ENTRIES}
        selectedIndex={0}
        query=""
        loading={false}
        onPick={onPick}
      />,
    );
    const rows = container.querySelectorAll('[role="option"]');
    const target = rows[1];
    expect(target).toBeTruthy();
    if (target !== null && target !== undefined) {
      fireEvent.mouseDown(target);
    }
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(ENTRIES[1]);
  });

  test('empty entries with loading shows loading state', () => {
    const { container } = render(
      <FileMentionAutocomplete
        entries={[]}
        selectedIndex={0}
        query="foo"
        loading={true}
        onPick={vi.fn()}
      />,
    );
    expect(container.textContent?.toLowerCase()).toContain('search');
  });

  test('empty entries without loading shows the no-match hint', () => {
    const { container } = render(
      <FileMentionAutocomplete
        entries={[]}
        selectedIndex={0}
        query="zzz"
        loading={false}
        onPick={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('@zzz');
  });
});

function makeAttachment(
  overrides: Partial<ComposerImageAttachment> = {},
): ComposerImageAttachment {
  return {
    id: 'a1',
    mimeType: 'image/png',
    base64: 'AAA',
    sizeBytes: 1024,
    previewUrl: 'data:image/png;base64,AAA',
    name: 'shot.png',
    width: 100,
    height: 60,
    ...overrides,
  };
}

describe('ImageAttachmentPreview', () => {
  test('returns null when there are no attachments', () => {
    const { container } = render(
      <ImageAttachmentPreview attachments={[]} onRemove={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test('renders one chip per attachment with byte + dimension meta', () => {
    const { container } = render(
      <ImageAttachmentPreview
        attachments={[
          makeAttachment(),
          makeAttachment({ id: 'a2', sizeBytes: 2_500_000, name: 'big.jpg' }),
        ]}
        onRemove={vi.fn()}
      />,
    );
    const chips = container.querySelectorAll('[role="listitem"]');
    expect(chips.length).toBe(2);
    expect(container.textContent).toContain('100×60');
    expect(container.textContent?.toLowerCase()).toContain('mb');
  });

  test('clicking remove button invokes onRemove with the attachment id', () => {
    const onRemove = vi.fn();
    const { container } = render(
      <ImageAttachmentPreview
        attachments={[makeAttachment({ id: 'pickme' })]}
        onRemove={onRemove}
      />,
    );
    const btn = container.querySelector('button');
    expect(btn).not.toBeNull();
    if (btn !== null) fireEvent.click(btn);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith('pickme');
  });
});
