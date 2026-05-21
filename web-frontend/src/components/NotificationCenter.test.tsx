/**
 * NotificationCenter — section rendering, click→jump+mark-read, and
 * the bulk action buttons.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { useStore } from '../state/store';

import { NotificationCenter } from './NotificationCenter';

const initialState = useStore.getState();

beforeEach(() => {
  useStore.setState({
    ...initialState,
    notifications: [],
    notificationsOpen: true,
    activeSessionId: null,
    browserNotificationsEnabled: false,
  });
});

afterEach(() => {
  cleanup();
});

describe('NotificationCenter', () => {
  test('renders empty state when there are no notifications', () => {
    render(<NotificationCenter onClose={() => undefined} />);
    expect(screen.getByText(/all caught up/i)).toBeTruthy();
  });

  test('renders unread + read sections with counts', () => {
    useStore.getState().pushNotification({
      type: 'agent_completed',
      title: 'unread one',
    });
    useStore.getState().pushNotification({
      type: 'agent_completed',
      title: 'read one',
    });
    const id = useStore.getState().notifications[1]?.id;
    useStore.getState().markRead(id ?? '');

    render(<NotificationCenter onClose={() => undefined} />);
    expect(screen.getByText('Unread (1)')).toBeTruthy();
    // Read section header is rendered (collapsed by default).
    expect(screen.getByTestId('notification-read-toggle').textContent).toMatch(
      /Read \(1\)/,
    );
  });

  test('click on a row jumps to the session and marks it read', () => {
    useStore.getState().pushNotification({
      type: 'approval_required',
      title: 'approve me',
      sessionId: 'session-x',
    });
    const id = useStore.getState().notifications[0]?.id ?? '';
    const onClose = vi.fn();
    render(<NotificationCenter onClose={onClose} />);

    fireEvent.click(screen.getByTestId(`notification-row-${id}`));

    const after = useStore.getState();
    expect(after.activeSessionId).toBe('session-x');
    expect(after.notifications[0]?.read).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('per-row dismiss button marks it read without jumping', () => {
    useStore.getState().pushNotification({
      type: 'agent_completed',
      title: 'a',
      sessionId: 'session-y',
    });
    const id = useStore.getState().notifications[0]?.id ?? '';
    const onClose = vi.fn();
    render(<NotificationCenter onClose={onClose} />);

    fireEvent.click(screen.getByTestId(`notification-dismiss-${id}`));
    const after = useStore.getState();
    expect(after.notifications[0]?.read).toBe(true);
    // Should NOT jump to the session or close.
    expect(after.activeSessionId).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('"Mark all as read" flips every entry', () => {
    useStore.getState().pushNotification({ type: 'agent_completed', title: 'a' });
    useStore.getState().pushNotification({ type: 'agent_errored', title: 'b' });
    render(<NotificationCenter onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('notification-mark-all-read'));
    expect(
      useStore.getState().notifications.every((n) => n.read),
    ).toBe(true);
  });

  test('"Clear all" empties the list', () => {
    useStore.getState().pushNotification({ type: 'agent_completed', title: 'a' });
    useStore.getState().pushNotification({ type: 'agent_completed', title: 'b' });
    render(<NotificationCenter onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('notification-clear-all'));
    expect(useStore.getState().notifications).toHaveLength(0);
  });

  test('Escape key closes the popover', () => {
    const onClose = vi.fn();
    render(<NotificationCenter onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('expanding the read section reveals read rows', () => {
    useStore.getState().pushNotification({
      type: 'agent_completed',
      title: 'read item',
    });
    const id = useStore.getState().notifications[0]?.id ?? '';
    useStore.getState().markRead(id);

    render(<NotificationCenter onClose={() => undefined} />);
    // Collapsed by default — the row should NOT be in the DOM.
    expect(screen.queryByTestId(`notification-row-${id}`)).toBeNull();
    fireEvent.click(screen.getByTestId('notification-read-toggle'));
    expect(screen.getByTestId(`notification-row-${id}`)).toBeTruthy();
  });
});
