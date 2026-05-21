/**
 * SessionSearchOverlay — cross-session full-text message search.
 *
 * Powered by the FTS5-backed `GET /api/search` endpoint. Renders a
 * dialog with an auto-focused search input, a scope toggle (current
 * project vs all projects), and a ranked, snippet-highlighted result
 * list. Clicking a result navigates to the source session (switching
 * the active project first when the hit lives outside the current
 * project's tree).
 *
 * Modal chrome (backdrop / ESC / focus trap / scroll lock) is provided
 * by the shared `<Modal>` primitive.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
} from 'react';

import { useApiClients } from '../App';
import { useT } from '../i18n';
import { Search } from '../icons';
import type { SearchResultWire } from '../../../src/web/protocol/rest-types.js';
import { useStore } from '../state/store';
import { Modal, ModalBody, ModalFooter } from './Modal';

import styles from './SessionSearchOverlay.module.css';

/** Debounce window for fetch-on-keystroke (ms). */
const DEBOUNCE_MS = 200;
/** Max results per page (clamped server-side, mirrored for clarity). */
const PAGE_LIMIT = 20;

type Scope = 'all' | 'project';

export function SessionSearchOverlay(): JSX.Element {
  const t = useT();
  const clients = useApiClients();

  const closeSessionSearch = useStore((s) => s.closeSessionSearch);
  const setActiveSession = useStore((s) => s.setActiveSession);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const activeProjectId = useStore((s) => s.activeProjectId);

  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>(
    activeProjectId === null ? 'all' : 'project',
  );
  const [results, setResults] = useState<SearchResultWire[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentQuery, setCurrentQuery] = useState('');

  const inputRef = useRef<HTMLInputElement | null>(null);

  // Autofocus on mount. The Modal owns the focus trap; we just kick the
  // initial focus into the search field.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced fetch — fires DEBOUNCE_MS after the user stops typing or
  // changes scope. Empty queries short-circuit so we don't pay for a
  // round-trip with no hits.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setTotal(0);
      setLoading(false);
      setError(null);
      setCurrentQuery('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const req: {
            q: string;
            projectId?: string;
            limit?: number;
          } = { q: trimmed, limit: PAGE_LIMIT };
          if (scope === 'project' && activeProjectId !== null) {
            req.projectId = activeProjectId;
          }
          const res = await clients.rest.searchSessions(req);
          if (cancelled) return;
          setResults(res.results);
          setTotal(res.total);
          setCurrentQuery(trimmed);
        } catch (err) {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          setResults([]);
          setTotal(0);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query, scope, activeProjectId, clients]);

  const handlePick = useCallback(
    (result: SearchResultWire) => {
      // When the hit lives in a different project, switch the active
      // project first so the sidebar tree and the chat view reconcile
      // around the new session.
      if (
        result.projectId !== null &&
        result.projectId !== activeProjectId
      ) {
        setActiveProject(result.projectId);
      }
      setActiveSession(result.sessionId);
      closeSessionSearch();
    },
    [activeProjectId, setActiveProject, setActiveSession, closeSessionSearch],
  );

  // Snippet HTML — FTS5 only emits the literal `<mark>` / `</mark>`
  // tags we configured + the verbatim content text. We trust this
  // source: the user authored the content in the chat composer and
  // the server doesn't synthesise any other markup. Rendering via
  // `dangerouslySetInnerHTML` lets the user see what matched.
  const renderSnippet = useCallback(
    (snippet: string): JSX.Element => (
      <span
        className={styles.snippet}
        // eslint-disable-next-line react/no-danger -- FTS5-emitted markup only contains <mark>; content is user-authored text that already round-tripped through the chat composer.
        dangerouslySetInnerHTML={{ __html: snippet }}
      />
    ),
    [],
  );

  const formatRole = useCallback(
    (role: string): string => {
      if (role === 'user') return t('sessionSearch.role.user');
      if (role === 'assistant') return t('sessionSearch.role.assistant');
      if (role === 'tool') return t('sessionSearch.role.tool');
      return t('sessionSearch.role.system');
    },
    [t],
  );

  const scopeDisabled = activeProjectId === null;

  const body = useMemo<JSX.Element>(() => {
    if (loading) {
      return (
        <div className={styles.empty}>
          <span>{t('sessionSearch.loading')}</span>
        </div>
      );
    }
    if (error !== null) {
      return (
        <div className={styles.error} role="alert">
          {t('sessionSearch.failed', { message: error })}
        </div>
      );
    }
    if (query.trim().length === 0) {
      return (
        <div className={styles.empty}>
          <span>{t('sessionSearch.empty.idle')}</span>
        </div>
      );
    }
    if (results.length === 0) {
      return (
        <div className={styles.empty}>
          <span>
            {t('sessionSearch.empty.noMatches', { query: currentQuery })}
          </span>
        </div>
      );
    }
    return (
      <ul className={styles.list} role="listbox" aria-label={t('sessionSearch.title')}>
        {results.map((r) => {
          const title =
            r.sessionTitle !== null && r.sessionTitle.length > 0
              ? r.sessionTitle
              : t('sessionSearch.untitled');
          const projectLabel = r.projectLabel ?? '';
          return (
            <li key={`${r.sessionId}:${r.messageId}`} role="option" aria-selected="false">
              <button
                type="button"
                className={styles.item}
                onClick={(e: MouseEvent<HTMLButtonElement>) => {
                  e.preventDefault();
                  handlePick(r);
                }}
              >
                <span className={styles.row1}>
                  <span className={styles.title}>{title}</span>
                  <span className={styles.role}>{formatRole(r.role)}</span>
                  <span className={styles.timestamp}>
                    {formatRelative(r.createdAt)}
                  </span>
                </span>
                {projectLabel.length > 0 ? (
                  <span className={styles.project}>{projectLabel}</span>
                ) : null}
                {renderSnippet(r.snippet)}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }, [
    loading,
    error,
    query,
    currentQuery,
    results,
    t,
    formatRole,
    renderSnippet,
    handlePick,
  ]);

  return (
    <Modal
      open={true}
      onClose={closeSessionSearch}
      title={t('sessionSearch.title')}
      ariaLabel={t('sessionSearch.title')}
      icon={<Search size={16} strokeWidth={1.5} />}
      size="lg"
    >
      <ModalBody>
        <div className={styles.searchRow}>
          <input
            ref={inputRef}
            className={styles.search}
            type="search"
            placeholder={t('sessionSearch.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('sessionSearch.placeholderAria')}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className={styles.scopeRow} role="group" aria-label={t('sessionSearch.scope.label')}>
          <button
            type="button"
            className={`${styles.scopeBtn} ${scope === 'all' ? styles.scopeBtnActive : ''}`}
            onClick={() => setScope('all')}
            aria-pressed={scope === 'all'}
          >
            {t('sessionSearch.scope.all')}
          </button>
          <button
            type="button"
            className={`${styles.scopeBtn} ${scope === 'project' ? styles.scopeBtnActive : ''}`}
            onClick={() => setScope('project')}
            aria-pressed={scope === 'project'}
            disabled={scopeDisabled}
            title={
              scopeDisabled
                ? t('sessionSearch.scope.project')
                : t('sessionSearch.scope.project')
            }
          >
            {t('sessionSearch.scope.project')}
          </button>
        </div>
        <div className={styles.resultsArea}>{body}</div>
      </ModalBody>
      <ModalFooter>
        <span className={styles.footer}>
          {results.length > 0
            ? t('sessionSearch.footer.count', {
                count: results.length,
                total,
              })
            : ''}
        </span>
      </ModalFooter>
    </Modal>
  );
}

/**
 * Compact relative-time label (`5m`, `2h`, `3d`, `Jan 12`).
 * Pure helper — no i18n integration yet; the timestamps live alongside
 * already-translated content so the unit suffixes stay short ASCII.
 */
function formatRelative(epochMs: number): string {
  const now = Date.now();
  const diff = now - epochMs;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}h`;
  }
  if (diff < 86_400_000 * 7) {
    return `${Math.floor(diff / 86_400_000)}d`;
  }
  const d = new Date(epochMs);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = monthNames[d.getMonth()] ?? '';
  return `${m} ${d.getDate()}`;
}
