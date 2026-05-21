/**
 * Zustand store actions — pure unit tests, no React rendering.
 */

import { beforeEach, describe, expect, test } from 'vitest';

import { useStore } from '../state/store';

const initialState = useStore.getState();

beforeEach(() => {
  // Reset to a clean known state between tests.
  useStore.setState({
    ...initialState,
    projects: [],
    activeProjectId: null,
    sessions: [],
    activeSessionId: null,
    activeBackend: null,
    baseUrl: null,
    models: [],
    currentModel: null,
    latestUsage: null,
    currentMaxContextTokens: null,
    toasts: [],
    csrfToken: null,
    fileBrowserOpen: false,
    fileBrowser: {
      expandedPaths: {},
      selectedKey: null,
      showHidden: false,
      searchQuery: '',
      treeCache: {},
      loadingPaths: {},
      errorByPath: {},
    },
    sidebarCollapsed: false,
    connection: { status: 'connecting', lastError: null },
  });
});

describe('useStore', () => {
  test('setProjects replaces the list', () => {
    useStore.getState().setProjects([
      { id: 'p1', root: '/a', label: 'A', lastUsedAt: 1 },
    ]);
    expect(useStore.getState().projects).toHaveLength(1);
  });

  test('setActiveProject persists the id', () => {
    useStore.getState().setActiveProject('p1');
    expect(useStore.getState().activeProjectId).toBe('p1');
  });

  test('pushToast assigns id + createdAt and appends', () => {
    useStore.getState().pushToast({ level: 'info', message: 'hello' });
    useStore.getState().pushToast({ level: 'success', message: 'world' });
    const toasts = useStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts[0]?.id).toBeTruthy();
    expect(toasts[0]?.createdAt).toBeGreaterThan(0);
    expect(toasts[1]?.message).toBe('world');
    // ids unique
    expect(toasts[0]?.id).not.toBe(toasts[1]?.id);
  });

  test('dismissToast removes by id', () => {
    useStore.getState().pushToast({ level: 'info', message: 'a' });
    useStore.getState().pushToast({ level: 'info', message: 'b' });
    const id = useStore.getState().toasts[0]?.id;
    expect(id).toBeTruthy();
    useStore.getState().dismissToast(id ?? '');
    expect(useStore.getState().toasts).toHaveLength(1);
    expect(useStore.getState().toasts[0]?.message).toBe('b');
  });

  test('setProviderInfo writes backend/baseUrl/models/currentModel', () => {
    useStore.getState().setProviderInfo({
      backend: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o', 'gpt-4o-mini'],
      currentModel: 'gpt-4o',
    });
    const s = useStore.getState();
    expect(s.activeBackend).toBe('openai');
    expect(s.baseUrl).toBe('https://api.openai.com/v1');
    expect(s.models).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(s.currentModel).toBe('gpt-4o');
  });

  test('setConnection merges partial fields', () => {
    useStore.getState().setConnection({ status: 'open' });
    expect(useStore.getState().connection.status).toBe('open');
    expect(useStore.getState().connection.lastError).toBeNull();
    useStore.getState().setConnection({ lastError: 'oops' });
    expect(useStore.getState().connection.status).toBe('open');
    expect(useStore.getState().connection.lastError).toBe('oops');
  });

  test('toggleSidebar / toggleFileBrowser flip booleans', () => {
    expect(useStore.getState().sidebarCollapsed).toBe(false);
    useStore.getState().toggleSidebar();
    expect(useStore.getState().sidebarCollapsed).toBe(true);
    useStore.getState().toggleFileBrowser();
    expect(useStore.getState().fileBrowserOpen).toBe(true);
  });

  test('setCsrfToken stores the token', () => {
    useStore.getState().setCsrfToken('abc');
    expect(useStore.getState().csrfToken).toBe('abc');
    useStore.getState().setCsrfToken(null);
    expect(useStore.getState().csrfToken).toBeNull();
  });
});

describe('fileBrowser slice', () => {
  test('toggleFileBrowserExpanded flips the bit', () => {
    const s = useStore.getState();
    s.toggleFileBrowserExpanded('p1:src');
    expect(useStore.getState().fileBrowser.expandedPaths['p1:src']).toBe(true);
    s.toggleFileBrowserExpanded('p1:src');
    expect(useStore.getState().fileBrowser.expandedPaths['p1:src']).toBeUndefined();
  });

  test('setFileBrowserSelected sets and clears', () => {
    const s = useStore.getState();
    s.setFileBrowserSelected('p1:foo.ts');
    expect(useStore.getState().fileBrowser.selectedKey).toBe('p1:foo.ts');
    s.setFileBrowserSelected(null);
    expect(useStore.getState().fileBrowser.selectedKey).toBeNull();
  });

  test('setFileBrowserShowHidden flips flag and invalidates cache', () => {
    const s = useStore.getState();
    s.setFileBrowserTreeCache('p1:', [
      { name: 'a', path: 'a', kind: 'file' },
    ]);
    expect(useStore.getState().fileBrowser.treeCache['p1:']).toHaveLength(1);
    s.setFileBrowserShowHidden(true);
    expect(useStore.getState().fileBrowser.showHidden).toBe(true);
    // Cache wiped to force a fresh fetch.
    expect(useStore.getState().fileBrowser.treeCache['p1:']).toBeUndefined();
  });

  test('setFileBrowserTreeCache stores a copy, clears any prior error', () => {
    const s = useStore.getState();
    s.setFileBrowserError('p1:', 'oops');
    s.setFileBrowserTreeCache('p1:', [
      { name: 'README.md', path: 'README.md', kind: 'file' },
    ]);
    const fb = useStore.getState().fileBrowser;
    expect(fb.treeCache['p1:']?.[0]?.name).toBe('README.md');
    expect(fb.errorByPath['p1:']).toBeUndefined();
  });

  test('setFileBrowserLoading toggles loading map', () => {
    const s = useStore.getState();
    s.setFileBrowserLoading('p1:src', true);
    expect(useStore.getState().fileBrowser.loadingPaths['p1:src']).toBe(true);
    s.setFileBrowserLoading('p1:src', false);
    expect(useStore.getState().fileBrowser.loadingPaths['p1:src']).toBeUndefined();
  });

  test('clearFileBrowserCache(projectId) only wipes that project', () => {
    const s = useStore.getState();
    s.setFileBrowserTreeCache('p1:', [{ name: 'a', path: 'a', kind: 'file' }]);
    s.setFileBrowserTreeCache('p2:', [{ name: 'b', path: 'b', kind: 'file' }]);
    s.clearFileBrowserCache('p1');
    const fb = useStore.getState().fileBrowser;
    expect(fb.treeCache['p1:']).toBeUndefined();
    expect(fb.treeCache['p2:']?.[0]?.name).toBe('b');
  });

  test('clearFileBrowserCache() with no argument wipes everything', () => {
    const s = useStore.getState();
    s.setFileBrowserTreeCache('p1:', [{ name: 'a', path: 'a', kind: 'file' }]);
    s.setFileBrowserTreeCache('p2:', [{ name: 'b', path: 'b', kind: 'file' }]);
    s.clearFileBrowserCache();
    expect(Object.keys(useStore.getState().fileBrowser.treeCache)).toHaveLength(0);
  });
});
