/**
 * FileBrowser — slide-in panel from the right side of the main column
 * presenting the active project's filesystem tree.
 *
 * UX contract (kept in sync with the user spec):
 *   - Header: project switcher dropdown + close X.
 *   - Toolbar: search · show-hidden · refresh.
 *   - Breadcrumbs: clickable path back to the project root.
 *   - Tree pane (left): lazy-loaded folders, file-type icons, hidden
 *     files toggleable, default-collapsed build dirs.
 *   - Preview pane (right): syntax-highlighted text OR inline image.
 *     Slides in from 0 → 50% width when a file is selected.
 *
 * State lives in `store.fileBrowser` so closing + reopening preserves
 * expansion, selection, and the lazy-load cache. The component is a
 * pure read-from-store consumer; all REST calls flow through the
 * `fetchTree`/`fetchFile` props passed down from `App.tsx`.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import type {
  FileTreeEntry,
  FileTreeResponse,
  FileReadResponse,
} from '../../../src/web/protocol/rest-types.js';
import { useT } from '../i18n';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  FolderClosed,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  X,
  AlertTriangle,
} from '../icons';
import { useStore, type FileEntryWire } from '../state/store';
import { pickFileIcon } from '../util/file-icons';

import { Breadcrumbs } from './Breadcrumbs';
import { EmptyState } from './EmptyState';
import { FilePreview } from './FilePreview';

import styles from './FileBrowser.module.css';

export interface FileBrowserProps {
  /** Project root path (absolute, display only). */
  rootPath: string;
  /** Project id used for REST calls. */
  projectId: string;
  /**
   * Fetch the tree at `path`. The signature is compatible with the
   * `App.tsx` `fetchFileTree` thunk that already takes an optional
   * subpath. Depth + showHidden are passed via the same thunk shape if
   * the caller supports it — App.tsx forwards to `restClient.fileTree`
   * which honours `subpath`, `depth`, `showHidden`.
   */
  fetchTree: (path?: string) => Promise<FileTreeResponse>;
  /** Read a file by path. */
  fetchFile: (path: string) => Promise<FileReadResponse>;
  onClose: () => void;
}

/** Default-collapsed names — visible only when `showHidden=true`. */
const DEFAULT_COLLAPSED: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
]);

/** Key shape for the per-project store maps. */
function makeKey(projectId: string, subpath: string): string {
  return `${projectId}:${subpath}`;
}

/**
 * Filter visible entries by the search query. We do a case-insensitive
 * substring match against the filename. When the query is empty, the
 * caller's `entries` are returned unchanged.
 *
 * NOTE: for folders, we keep them in the result regardless of match so
 * the user can drill down. Empty subtrees are pruned by the caller.
 */
function filterEntries(entries: readonly FileEntryWire[], query: string): FileEntryWire[] {
  if (query === '') return [...entries];
  const q = query.toLowerCase();
  const out: FileEntryWire[] = [];
  for (const e of entries) {
    if (e.kind === 'dir' || e.name.toLowerCase().includes(q)) {
      out.push(e);
    }
  }
  return out;
}

/** Highlight the matching substring inside `text`. */
function HighlightMatch({ text, query }: { text: string; query: string }): JSX.Element {
  if (query === '') return <>{text}</>;
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className={styles.match}>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

/**
 * Compute a stable indent for a row based on depth. We use inline
 * padding rather than `text-indent` to keep the hit-target (the button)
 * actually clickable at every level.
 */
function indentPad(depth: number): string {
  return `${depth * 16}px`;
}

interface ContextMenuState {
  /** Absolute viewport coords for the menu anchor. */
  x: number;
  y: number;
  /** The entry the menu refers to. */
  entry: FileTreeEntry;
}

export function FileBrowser(props: FileBrowserProps): JSX.Element {
  const t = useT();
  const { rootPath, projectId, fetchTree, fetchFile, onClose } = props;

  // ---- Store slice ----
  const fb = useStore((s) => s.fileBrowser);
  const projects = useStore((s) => s.projects);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const toggleExpanded = useStore((s) => s.toggleFileBrowserExpanded);
  const setExpanded = useStore((s) => s.setFileBrowserExpanded);
  const setSelected = useStore((s) => s.setFileBrowserSelected);
  const setShowHidden = useStore((s) => s.setFileBrowserShowHidden);
  const setSearch = useStore((s) => s.setFileBrowserSearch);
  const setTreeCache = useStore((s) => s.setFileBrowserTreeCache);
  const setLoading = useStore((s) => s.setFileBrowserLoading);
  const setError = useStore((s) => s.setFileBrowserError);
  const clearCache = useStore((s) => s.clearFileBrowserCache);
  const pushToast = useStore((s) => s.pushToast);

  // ---- Local UI state (not worth persisting) ----
  const [debouncedQuery, setDebouncedQuery] = useState(fb.searchQuery);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  // Path used by the "current breadcrumb scope" — clicking a crumb
  // sets this and we scroll-to-load that subtree. The actual tree is
  // still rendered from the root cache; the breadcrumb scope only
  // controls the title above the tree.
  const [breadcrumbSubpath, setBreadcrumbSubpath] = useState('');

  // ---- Refs for keyboard nav ----
  const treeRef = useRef<HTMLDivElement>(null);

  // Debounce the search input (150ms per spec).
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(fb.searchQuery), 150);
    return () => clearTimeout(handle);
  }, [fb.searchQuery]);

  // ---- Tree fetching ----

  // The fetchTree thunk from App.tsx accepts only `path`. We extend
  // its behaviour at the source by detecting `showHidden` from the
  // store and re-fetching when the toggle changes. The cache key
  // already includes `showHidden` implicitly because we drop the cache
  // when the toggle flips (see `setFileBrowserShowHidden`).
  const loadTree = useCallback(
    async (subpath: string): Promise<void> => {
      const key = makeKey(projectId, subpath);
      if (fb.treeCache[key] !== undefined) return;
      if (fb.loadingPaths[key] === true) return;
      setLoading(key, true);
      try {
        const res = await fetchTree(subpath);
        const entries: FileEntryWire[] = res.entries.map((e) => {
          const out: FileEntryWire = {
            name: e.name,
            path: e.path,
            kind: e.kind,
          };
          if (e.size !== undefined) out.size = e.size;
          if (e.mtime !== undefined) out.mtime = e.mtime;
          return out;
        });
        setTreeCache(key, entries);
        setError(key, null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(key, message);
      } finally {
        setLoading(key, false);
      }
    },
    [
      projectId,
      fetchTree,
      fb.treeCache,
      fb.loadingPaths,
      setLoading,
      setTreeCache,
      setError,
    ],
  );

  // Initial root fetch + refetch on project change.
  useEffect(() => {
    void loadTree('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, fb.showHidden]);

  // ESC closes the panel (unless a file is selected; first ESC clears
  // selection, second ESC closes — feels less destructive on accident).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (fb.selectedKey !== null) {
        e.preventDefault();
        setSelected(null);
        return;
      }
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [fb.selectedKey, onClose, setSelected]);

  // ---- Tree row handlers ----

  const onExpand = useCallback(
    (entry: FileTreeEntry) => {
      if (entry.kind !== 'dir') return;
      const key = makeKey(projectId, entry.path);
      const isOpen = fb.expandedPaths[key] === true;
      toggleExpanded(key);
      if (!isOpen) {
        // Lazy-load on first expansion.
        void loadTree(entry.path);
      }
    },
    [projectId, fb.expandedPaths, toggleExpanded, loadTree],
  );

  const onSelect = useCallback(
    (entry: FileTreeEntry) => {
      if (entry.kind !== 'file') return;
      setSelected(makeKey(projectId, entry.path));
    },
    [projectId, setSelected],
  );

  // ---- Project switcher ----

  const onPickProject = useCallback(
    (id: string) => {
      if (id === projectId) {
        setProjectMenuOpen(false);
        return;
      }
      setProjectMenuOpen(false);
      clearCache();
      setSelected(null);
      setActiveProject(id);
    },
    [projectId, clearCache, setActiveProject, setSelected],
  );

  // ---- Refresh ----
  const onRefresh = useCallback(() => {
    clearCache(projectId);
    void loadTree('');
    // Re-fetch all currently-expanded subpaths.
    for (const key of Object.keys(fb.expandedPaths)) {
      const sep = key.indexOf(':');
      if (sep === -1) continue;
      const pid = key.slice(0, sep);
      const sub = key.slice(sep + 1);
      if (pid === projectId && sub !== '') {
        void loadTree(sub);
      }
    }
  }, [projectId, clearCache, loadTree, fb.expandedPaths]);

  // ---- Context menu ----

  const onContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLElement>, entry: FileTreeEntry) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, entry });
    },
    [],
  );

  const copyAbsolute = useCallback(
    (entry: FileTreeEntry) => {
      if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
        return;
      }
      const abs = `${rootPath.replace(/\/+$/, '')}/${entry.path}`;
      navigator.clipboard.writeText(abs).then(
        () => pushToast({ level: 'success', message: t('fileBrowser.copied') }),
        () => {
          /* clipboard rejected — silent */
        },
      );
      setContextMenu(null);
    },
    [rootPath, pushToast, t],
  );

  const copyRelative = useCallback(
    (entry: FileTreeEntry) => {
      if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
        return;
      }
      navigator.clipboard.writeText(entry.path).then(
        () => pushToast({ level: 'success', message: t('fileBrowser.copied') }),
        () => {
          /* clipboard rejected — silent */
        },
      );
      setContextMenu(null);
    },
    [pushToast, t],
  );

  // Close context menu on outside click / ESC.
  useEffect(() => {
    if (contextMenu === null) return;
    const onClick = (): void => setContextMenu(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  // ---- Flatten the tree for rendering ----

  interface VisibleRow {
    entry: FileTreeEntry;
    depth: number;
    parentKey: string;
  }

  const visibleRows = useMemo<VisibleRow[]>(() => {
    const rootKey = makeKey(projectId, '');
    const rootEntries = fb.treeCache[rootKey];
    if (rootEntries === undefined) return [];

    const out: VisibleRow[] = [];
    const walk = (parent: string, entries: readonly FileEntryWire[], depth: number): void => {
      const filtered = filterEntries(entries, debouncedQuery);
      for (const e of filtered) {
        const entryKey = makeKey(projectId, e.path);
        out.push({ entry: e, depth, parentKey: parent });
        if (e.kind === 'dir' && fb.expandedPaths[entryKey] === true) {
          const children = fb.treeCache[entryKey];
          if (children !== undefined) {
            walk(entryKey, children, depth + 1);
          }
        }
      }
    };
    walk(rootKey, rootEntries, 0);
    return out;
  }, [projectId, fb.treeCache, fb.expandedPaths, debouncedQuery]);

  // ---- Keyboard nav across visible rows ----

  const focusedIndex = useMemo(() => {
    if (fb.selectedKey === null) return -1;
    return visibleRows.findIndex(
      (r) => makeKey(projectId, r.entry.path) === fb.selectedKey,
    );
  }, [visibleRows, fb.selectedKey, projectId]);

  const onTreeKey = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (visibleRows.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = Math.min(visibleRows.length - 1, Math.max(0, focusedIndex + 1));
        const row = visibleRows[next];
        if (row !== undefined && row.entry.kind === 'file') {
          setSelected(makeKey(projectId, row.entry.path));
        } else if (row !== undefined) {
          // For folder rows, set selected to its key so arrow keys can
          // continue from there (selection in the UI reflects keyboard
          // focus). Folder click still opens-or-collapses on Enter.
          setSelected(makeKey(projectId, row.entry.path));
        }
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const next = Math.max(0, focusedIndex - 1);
        const row = visibleRows[next];
        if (row !== undefined) {
          setSelected(makeKey(projectId, row.entry.path));
        }
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        const row = visibleRows[focusedIndex];
        if (row !== undefined && row.entry.kind === 'dir') {
          const key = makeKey(projectId, row.entry.path);
          if (fb.expandedPaths[key] !== true) {
            setExpanded(key, true);
            void loadTree(row.entry.path);
          }
        }
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const row = visibleRows[focusedIndex];
        if (row !== undefined && row.entry.kind === 'dir') {
          const key = makeKey(projectId, row.entry.path);
          if (fb.expandedPaths[key] === true) {
            setExpanded(key, false);
            return;
          }
        }
        // Collapsed dir or file → jump to parent in the visible list.
        const parentKey = row?.parentKey;
        if (parentKey !== undefined && parentKey.length > 0) {
          const parentSubpath = parentKey.slice(projectId.length + 1);
          if (parentSubpath !== '') {
            setSelected(parentKey);
          }
        }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const row = visibleRows[focusedIndex];
        if (row === undefined) return;
        if (row.entry.kind === 'dir') {
          onExpand(row.entry);
        } else {
          onSelect(row.entry);
        }
      }
    },
    [
      visibleRows,
      focusedIndex,
      projectId,
      fb.expandedPaths,
      setSelected,
      setExpanded,
      loadTree,
      onExpand,
      onSelect,
    ],
  );

  // ---- Project switcher data ----

  const currentProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );

  const rootLabel = useMemo(() => {
    if (currentProject !== null && currentProject.label.length > 0) {
      return currentProject.label;
    }
    const trimmed = rootPath.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  }, [currentProject, rootPath]);

  // ---- Render ----

  const rootKey = makeKey(projectId, '');
  const rootEntries = fb.treeCache[rootKey];
  const rootError = fb.errorByPath[rootKey];
  const rootLoading = fb.loadingPaths[rootKey] === true && rootEntries === undefined;
  const selectedSubpath = useMemo(() => {
    if (fb.selectedKey === null) return null;
    const sep = fb.selectedKey.indexOf(':');
    if (sep === -1) return null;
    const pid = fb.selectedKey.slice(0, sep);
    if (pid !== projectId) return null;
    return fb.selectedKey.slice(sep + 1);
  }, [fb.selectedKey, projectId]);

  const showSearchEmpty =
    rootEntries !== undefined &&
    rootEntries.length > 0 &&
    visibleRows.length === 0 &&
    debouncedQuery.length > 0;

  return (
    <aside
      className={`${styles.root} ${selectedSubpath !== null ? styles.rootSplit : ''}`}
      aria-label={t('fileBrowser.aria')}
    >
      <div className={styles.panel}>
        {/* Header — project switcher + close */}
        <header className={styles.header}>
          <div className={styles.projectPicker}>
            <button
              type="button"
              className={styles.projectBtn}
              onClick={() => setProjectMenuOpen((v) => !v)}
              aria-haspopup="listbox"
              aria-expanded={projectMenuOpen}
              title={t('fileBrowser.switchProject')}
            >
              <FolderOpen size={14} strokeWidth={1.5} />
              <span className={styles.projectName}>{rootLabel}</span>
              <ChevronDown size={12} strokeWidth={1.5} />
            </button>
            {projectMenuOpen ? (
              <ul
                className={styles.projectMenu}
                role="listbox"
                aria-label={t('fileBrowser.switchProject')}
              >
                {projects.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={`${styles.projectItem} ${p.id === projectId ? styles.projectItemActive : ''}`}
                      onClick={() => onPickProject(p.id)}
                      role="option"
                      aria-selected={p.id === projectId}
                    >
                      <span className={styles.projectItemName}>
                        {p.label.length > 0 ? p.label : p.root}
                      </span>
                      <span className={styles.projectItemPath} title={p.root}>
                        {p.root}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label={t('fileBrowser.close')}
            title={t('fileBrowser.close')}
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </header>

        {/* Toolbar — search · hidden · refresh */}
        <div className={styles.toolbar}>
          <label className={styles.searchWrap}>
            <Search size={12} strokeWidth={1.5} className={styles.searchIcon} />
            <input
              type="text"
              className={styles.searchInput}
              value={fb.searchQuery}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('fileBrowser.search')}
              aria-label={t('fileBrowser.search.aria')}
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className={`${styles.toolBtn} ${fb.showHidden ? styles.toolBtnActive : ''}`}
            onClick={() => setShowHidden(!fb.showHidden)}
            aria-label={fb.showHidden ? t('fileBrowser.hideHidden') : t('fileBrowser.showHidden')}
            title={fb.showHidden ? t('fileBrowser.hideHidden') : t('fileBrowser.showHidden')}
            aria-pressed={fb.showHidden}
          >
            {fb.showHidden ? (
              <Eye size={14} strokeWidth={1.5} />
            ) : (
              <EyeOff size={14} strokeWidth={1.5} />
            )}
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={onRefresh}
            aria-label={t('fileBrowser.refresh')}
            title={t('fileBrowser.refresh')}
          >
            <RefreshCw size={14} strokeWidth={1.5} />
          </button>
        </div>

        <Breadcrumbs
          rootLabel={rootLabel}
          subpath={breadcrumbSubpath}
          onNavigate={(sp) => {
            setBreadcrumbSubpath(sp);
            // Expand every ancestor along the path so the focus scrolls
            // into view. This is a cheap UX win.
            if (sp !== '') {
              const parts = sp.split('/').filter((x) => x.length > 0);
              let acc = '';
              for (const part of parts) {
                acc = acc === '' ? part : `${acc}/${part}`;
                const key = makeKey(projectId, acc);
                if (fb.expandedPaths[key] !== true) {
                  setExpanded(key, true);
                  void loadTree(acc);
                }
              }
            }
          }}
        />

        {/* Tree pane */}
        <div
          ref={treeRef}
          className={styles.tree}
          tabIndex={0}
          role="tree"
          aria-label={t('fileBrowser.tree.aria')}
          onKeyDown={onTreeKey}
        >
          {rootError !== undefined ? (
            <InlineError
              message={rootError}
              onRetry={() => {
                setError(rootKey, null);
                void loadTree('');
              }}
              retryLabel={t('fileBrowser.retry')}
            />
          ) : rootLoading ? (
            <div className={styles.loading}>
              <Loader2 size={14} strokeWidth={1.5} className={styles.spin} />
              <span>{t('fileBrowser.loadingTree')}</span>
            </div>
          ) : rootEntries === undefined || rootEntries.length === 0 ? (
            <EmptyState
              icon={Folder}
              title={t('fileBrowser.empty')}
              description={t('fileBrowser.empty.desc')}
            />
          ) : showSearchEmpty ? (
            <EmptyState
              icon={Search}
              title={t('fileBrowser.search.empty', { query: debouncedQuery })}
            />
          ) : (
            <ul className={styles.list} role="presentation">
              {visibleRows.map((row, idx) => {
                const key = makeKey(projectId, row.entry.path);
                const isOpen = row.entry.kind === 'dir' && fb.expandedPaths[key] === true;
                const isSelected = fb.selectedKey === key;
                const isLoading = fb.loadingPaths[key] === true;
                const isErr = fb.errorByPath[key];
                const isDefaultCollapsed =
                  row.entry.kind === 'dir' && DEFAULT_COLLAPSED.has(row.entry.name);
                return (
                  <li key={`${key}-${idx}`} role="none">
                    <TreeRow
                      entry={row.entry}
                      depth={row.depth}
                      isOpen={isOpen}
                      isSelected={isSelected}
                      isLoading={isLoading}
                      query={debouncedQuery}
                      defaultCollapsed={isDefaultCollapsed}
                      onExpand={() => onExpand(row.entry)}
                      onSelect={() => {
                        setSelected(key);
                        if (row.entry.kind === 'file') {
                          onSelect(row.entry);
                        } else {
                          onExpand(row.entry);
                        }
                      }}
                      onContextMenu={(e) => onContextMenu(e, row.entry)}
                    />
                    {isErr !== undefined ? (
                      <div
                        className={styles.childError}
                        style={{ paddingLeft: indentPad(row.depth + 1) }}
                      >
                        <AlertTriangle size={12} strokeWidth={1.5} />
                        <span>{isErr}</span>
                        <button
                          type="button"
                          className={styles.linkBtn}
                          onClick={() => {
                            setError(key, null);
                            void loadTree(row.entry.path);
                          }}
                        >
                          {t('fileBrowser.retry')}
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Preview pane (right half) */}
      {selectedSubpath !== null ? (
        <div className={styles.previewPane}>
          <FilePreview
            path={selectedSubpath}
            rootPath={rootPath}
            projectId={projectId}
            fetchFile={fetchFile}
            onClose={() => setSelected(null)}
          />
        </div>
      ) : null}

      {/* Context menu */}
      {contextMenu !== null ? (
        <div
          className={styles.contextMenu}
          style={{ top: contextMenu.y, left: contextMenu.x }}
          role="menu"
        >
          <button
            type="button"
            className={styles.contextItem}
            onClick={() => copyAbsolute(contextMenu.entry)}
            role="menuitem"
          >
            {t('fileBrowser.copyPath')}
          </button>
          <button
            type="button"
            className={styles.contextItem}
            onClick={() => copyRelative(contextMenu.entry)}
            role="menuitem"
          >
            {t('fileBrowser.copyRelative')}
          </button>
        </div>
      ) : null}
    </aside>
  );
}

// ---------- Internal components ----------

interface InlineErrorProps {
  message: string;
  retryLabel: string;
  onRetry: () => void;
}

function InlineError({ message, retryLabel, onRetry }: InlineErrorProps): JSX.Element {
  return (
    <div className={styles.errorRow}>
      <AlertTriangle size={14} strokeWidth={1.5} />
      <span className={styles.errorText}>{message}</span>
      <button type="button" className={styles.linkBtn} onClick={onRetry}>
        {retryLabel}
      </button>
    </div>
  );
}

interface TreeRowProps {
  entry: FileTreeEntry;
  depth: number;
  isOpen: boolean;
  isSelected: boolean;
  isLoading: boolean;
  query: string;
  defaultCollapsed: boolean;
  onExpand: () => void;
  onSelect: () => void;
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
}

function TreeRow({
  entry,
  depth,
  isOpen,
  isSelected,
  isLoading,
  query,
  defaultCollapsed,
  onExpand,
  onSelect,
  onContextMenu,
}: TreeRowProps): JSX.Element {
  const isDir = entry.kind === 'dir';
  const fileIcon = !isDir ? pickFileIcon(entry.name) : null;
  // For build dirs (`node_modules`, `.git`, …) use the FolderClosed
  // glyph as a visual cue that they're "muted" by convention.
  const FolderIcon = isDir
    ? isOpen
      ? FolderOpen
      : defaultCollapsed
      ? FolderClosed
      : Folder
    : null;

  return (
    <button
      type="button"
      className={`${styles.row} ${isSelected ? styles.selected : ''} ${defaultCollapsed ? styles.muted : ''}`}
      style={{ paddingLeft: indentPad(depth) }}
      onClick={(e) => {
        e.stopPropagation();
        if (isDir) {
          // For folders the row click toggles. The store-based onSelect
          // also fires to mark this row as the keyboard cursor.
          onExpand();
        } else {
          onSelect();
        }
      }}
      onContextMenu={onContextMenu}
      aria-selected={isSelected}
      role={isDir ? 'treeitem' : 'treeitem'}
      aria-expanded={isDir ? isOpen : undefined}
      title={entry.path}
    >
      <span className={styles.chevron}>
        {isDir ? (
          isOpen ? (
            <ChevronDown size={12} strokeWidth={1.5} />
          ) : (
            <ChevronRight size={12} strokeWidth={1.5} />
          )
        ) : null}
      </span>
      <span
        className={styles.icon}
        style={fileIcon !== null ? { color: `var(${fileIcon.colorVar})` } : undefined}
      >
        {isDir && FolderIcon !== null ? (
          <FolderIcon size={14} strokeWidth={1.5} />
        ) : fileIcon !== null ? (
          <fileIcon.Icon size={14} strokeWidth={1.5} />
        ) : null}
      </span>
      <span className={styles.name}>
        <HighlightMatch text={entry.name} query={query} />
      </span>
      {isLoading ? (
        <Loader2 size={12} strokeWidth={1.5} className={styles.spin} />
      ) : null}
      {!isDir ? (
        <span className={styles.rowActions}>
          <span
            className={styles.kebab}
            role="button"
            tabIndex={-1}
            aria-label="More actions"
            onClick={(e) => {
              e.stopPropagation();
              onContextMenu(e);
            }}
          >
            <MoreHorizontal size={12} strokeWidth={1.5} />
          </span>
        </span>
      ) : null}
    </button>
  );
}
