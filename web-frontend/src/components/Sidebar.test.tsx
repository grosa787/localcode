/**
 * Sidebar — viewport-driven collapsed / expanded / mobile-overlay states.
 *
 * Mounts the real component but injects the breakpoint via the new
 * `viewport` prop (which is wired by App.tsx in production). We don't
 * need to simulate ResizeObserver — Sidebar consumes the prop, not the
 * hook directly.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { useStore } from '../state/store';
import { Sidebar } from './Sidebar';

const initialState = useStore.getState();

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* ignored */
  }
  useStore.setState({
    ...initialState,
    sidebarCollapsed: false,
    projects: [],
    sessions: [],
    activeProjectId: null,
    activeSessionId: null,
  });
});

afterEach(() => {
  useStore.setState({ ...initialState });
});

describe('Sidebar — desktop', () => {
  test('renders the expanded sidebar with brand word', () => {
    render(<Sidebar viewport="desktop" />);
    expect(document.body.textContent).toContain('LocalCode');
  });

  test('viewport defaults to desktop when prop is omitted', () => {
    render(<Sidebar />);
    expect(document.body.textContent).toContain('LocalCode');
  });

  test('respects the persisted sidebarCollapsed boolean on desktop', () => {
    useStore.setState({ sidebarCollapsed: true });
    render(<Sidebar viewport="desktop" />);
    expect(document.body.textContent ?? '').not.toContain('LocalCode');
  });
});

describe('Sidebar — tablet', () => {
  test('always renders the icon strip regardless of sidebarCollapsed', () => {
    useStore.setState({ sidebarCollapsed: false });
    render(<Sidebar viewport="tablet" />);
    // Tablet forces collapsed=true so the brand word is hidden.
    expect(document.body.textContent ?? '').not.toContain('LocalCode');
    // The aside is marked with data-viewport for CSS targeting.
    const aside = document.querySelector('aside');
    expect(aside?.getAttribute('data-viewport')).toBe('tablet');
  });
});

describe('Sidebar — mobile', () => {
  test('hides the panel by default and shows the hamburger handle', () => {
    render(<Sidebar viewport="mobile" />);
    expect(screen.getByTestId('sidebar-mobile-handle')).toBeTruthy();
    const aside = document.querySelector('aside');
    expect(aside?.getAttribute('data-mobile-open')).toBe('false');
  });

  test('clicking the hamburger opens the drawer', () => {
    render(<Sidebar viewport="mobile" />);
    act(() => {
      fireEvent.click(screen.getByTestId('sidebar-mobile-handle'));
    });
    const aside = document.querySelector('aside');
    expect(aside?.getAttribute('data-mobile-open')).toBe('true');
    // After opening, the hamburger handle is hidden (drawer takes over).
    expect(screen.queryByTestId('sidebar-mobile-handle')).toBeNull();
  });

  test('clicking the backdrop closes the drawer', () => {
    render(<Sidebar viewport="mobile" />);
    act(() => {
      fireEvent.click(screen.getByTestId('sidebar-mobile-handle'));
    });
    const aside = document.querySelector('aside');
    expect(aside?.getAttribute('data-mobile-open')).toBe('true');
    act(() => {
      fireEvent.click(screen.getByTestId('sidebar-mobile-backdrop'));
    });
    expect(aside?.getAttribute('data-mobile-open')).toBe('false');
  });

  test('switching breakpoints away from mobile resets the drawer state', () => {
    const { rerender } = render(<Sidebar viewport="mobile" />);
    act(() => {
      fireEvent.click(screen.getByTestId('sidebar-mobile-handle'));
    });
    expect(document.querySelector('aside')?.getAttribute('data-mobile-open')).toBe('true');
    rerender(<Sidebar viewport="desktop" />);
    expect(document.querySelector('aside')?.getAttribute('data-mobile-open')).toBeNull();
  });
});
