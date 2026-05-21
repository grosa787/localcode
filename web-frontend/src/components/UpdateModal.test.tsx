/**
 * UpdateModal — VS-Code-style update dialog.
 *
 * Covers:
 *   - Default closed when no payload / store flag is false.
 *   - Renders header, body, footer when open.
 *   - Install / Later / Skip buttons fire the right callbacks AND close
 *     the modal via the store action.
 *   - Markdown bodies render headings + lists.
 *   - "Restart to apply" label fires when the matching version is staged.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { useStore, type UpdateAvailableInfo } from '../state/store';
import { UpdateModal } from './UpdateModal';

const initialState = useStore.getState();

function makeInfo(overrides: Partial<UpdateAvailableInfo> = {}): UpdateAvailableInfo {
  return {
    currentVersion: '0.19.0',
    latestVersion: '0.20.0',
    releaseUrl: 'https://github.com/local/code/releases/tag/v0.20.0',
    releaseName: 'Spring polish',
    body: '## Highlights\n- New modal\n- Background updates\n\n## Fixes\n- A bug',
    publishedAt: Date.parse('2026-05-19T12:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  useStore.setState({
    ...initialState,
    updateAvailable: null,
    updateModalOpen: false,
    updateDownloadedVersion: null,
  });
});

afterEach(() => {
  useStore.setState({ ...initialState });
});

describe('UpdateModal — closed states', () => {
  test('returns null when no payload', () => {
    render(<UpdateModal />);
    expect(screen.queryByTestId('update-modal-body')).toBeNull();
  });

  test('returns null when payload exists but modal is closed', () => {
    useStore.setState({
      updateAvailable: makeInfo(),
      updateModalOpen: false,
    });
    render(<UpdateModal />);
    expect(screen.queryByTestId('update-modal-body')).toBeNull();
  });
});

describe('UpdateModal — open state', () => {
  test('renders title, body, and three action buttons', () => {
    useStore.setState({
      updateAvailable: makeInfo(),
      updateModalOpen: true,
    });
    render(<UpdateModal />);
    expect(document.body.textContent).toContain('Update available');
    expect(document.body.textContent).toContain('v0.19.0');
    expect(document.body.textContent).toContain('v0.20.0');

    expect(screen.getByTestId('update-modal-install').textContent).toBe('Install now');
    expect(screen.getByTestId('update-modal-later')).not.toBeNull();
    expect(screen.getByTestId('update-modal-skip').textContent).toContain('0.20.0');
  });

  test('renders markdown headings + list items from body', () => {
    useStore.setState({
      updateAvailable: makeInfo(),
      updateModalOpen: true,
    });
    render(<UpdateModal />);
    const notes = screen.getByTestId('update-modal-notes');
    expect(notes.querySelector('h2')?.textContent).toContain('Highlights');
    const items = notes.querySelectorAll('li');
    expect(items.length).toBeGreaterThanOrEqual(3);
  });

  test('renders Restart to apply when the latest version is already staged', () => {
    useStore.setState({
      updateAvailable: makeInfo(),
      updateModalOpen: true,
      updateDownloadedVersion: '0.20.0',
    });
    render(<UpdateModal />);
    expect(screen.getByTestId('update-modal-install').textContent).toBe(
      'Restart to apply',
    );
  });
});

describe('UpdateModal — actions', () => {
  test('Install fires onInstall and closes modal', () => {
    useStore.setState({
      updateAvailable: makeInfo(),
      updateModalOpen: true,
    });
    const onInstall = vi.fn();
    render(<UpdateModal onInstall={onInstall} />);
    act(() => {
      fireEvent.click(screen.getByTestId('update-modal-install'));
    });
    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(useStore.getState().updateModalOpen).toBe(false);
  });

  test('Later fires onLater with a ~24h-from-now deadline', () => {
    useStore.setState({
      updateAvailable: makeInfo(),
      updateModalOpen: true,
    });
    const onLater = vi.fn();
    render(<UpdateModal onLater={onLater} />);
    const before = Date.now();
    act(() => {
      fireEvent.click(screen.getByTestId('update-modal-later'));
    });
    expect(onLater).toHaveBeenCalledTimes(1);
    const callArg = onLater.mock.calls[0]?.[0] as number;
    const expected = before + 24 * 60 * 60 * 1_000;
    expect(callArg).toBeGreaterThanOrEqual(expected - 1_000);
    expect(callArg).toBeLessThanOrEqual(expected + 5_000);
    expect(useStore.getState().updateModalOpen).toBe(false);
  });

  test('Skip fires onSkip with the latest version and closes modal', () => {
    useStore.setState({
      updateAvailable: makeInfo(),
      updateModalOpen: true,
    });
    const onSkip = vi.fn();
    render(<UpdateModal onSkip={onSkip} />);
    act(() => {
      fireEvent.click(screen.getByTestId('update-modal-skip'));
    });
    expect(onSkip).toHaveBeenCalledWith('0.20.0');
    expect(useStore.getState().updateModalOpen).toBe(false);
  });
});

describe('UpdateModal — explicit props override store', () => {
  test('info + open props win over the store', () => {
    useStore.setState({
      updateAvailable: null,
      updateModalOpen: false,
    });
    const info = makeInfo({ latestVersion: '0.99.0' });
    render(<UpdateModal info={info} open />);
    expect(screen.getByTestId('update-modal-body')).not.toBeNull();
    expect(screen.getByTestId('update-modal-skip').textContent).toContain('0.99.0');
  });
});
