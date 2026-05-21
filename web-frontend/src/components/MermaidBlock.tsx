/**
 * MermaidBlock — render mermaid code as SVG in the web chat.
 *
 * The mermaid library is heavy (~600KB minified), so we lazy-load it
 * via `import('mermaid')` only when the first mermaid block actually
 * mounts. Subsequent blocks share the cached module reference.
 *
 * Theme: we observe `document.documentElement.dataset.theme` so dark
 * mode picks mermaid's 'dark' theme and light mode picks 'default'.
 * A MutationObserver re-renders on theme switch.
 *
 * Error path: if parsing or rendering throws, we fall back to the raw
 * source inside a yellow-bordered frame with an "Invalid Mermaid" badge
 * — never a blank box.
 *
 * Fullscreen: clicking the SVG opens a zoom-and-pan overlay (drag to
 * pan, wheel to zoom). Escape or backdrop click closes it.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';

import styles from './MermaidBlock.module.css';

export interface MermaidBlockProps {
  readonly code: string;
}

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (
    id: string,
    text: string,
  ) => Promise<{ svg: string; bindFunctions?: (el: Element) => void }>;
};

interface MermaidModuleShape {
  readonly default: MermaidApi;
}

/**
 * Module-level promise cache. The first caller triggers the dynamic
 * import; subsequent callers await the same promise so we never
 * download mermaid twice. Returns the typed mermaid surface we use.
 */
let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (mermaidPromise !== null) return mermaidPromise;
  // The dynamic import returns `unknown`-shaped data from the bundler's
  // perspective; we narrow with a small runtime check so we never call
  // through a missing `.default` accidentally.
  mermaidPromise = import('mermaid').then((mod: unknown): MermaidApi => {
    const m = mod as Partial<MermaidModuleShape> & Partial<MermaidApi>;
    if (m.default !== undefined && typeof m.default.render === 'function') {
      return m.default;
    }
    if (typeof m.render === 'function' && typeof m.initialize === 'function') {
      return m as MermaidApi;
    }
    throw new Error('mermaid module does not expose the expected API');
  });
  return mermaidPromise;
}

function detectTheme(): 'dark' | 'default' {
  if (typeof document === 'undefined') return 'dark';
  const t = document.documentElement.dataset['theme'];
  if (t === 'light') return 'default';
  return 'dark';
}

/**
 * Stable per-block id so mermaid can build internal references that
 * don't collide across multiple diagrams on the same page.
 */
let counter = 0;
function nextId(): string {
  counter += 1;
  return `mmd-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

interface RenderState {
  readonly status: 'pending' | 'ready' | 'error';
  readonly svg: string;
  readonly error: string | null;
}

const INITIAL: RenderState = { status: 'pending', svg: '', error: null };

function MermaidBlockImpl({ code }: MermaidBlockProps): JSX.Element {
  const [state, setState] = useState<RenderState>(INITIAL);
  const [theme, setTheme] = useState<'dark' | 'default'>(() => detectTheme());
  const [fullscreen, setFullscreen] = useState(false);
  const id = useMemo(() => nextId(), []);

  // Observe theme changes — repaint when the user toggles dark/light.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const obs = new MutationObserver(() => setTheme(detectTheme()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => obs.disconnect();
  }, []);

  // Render whenever code or theme changes. We guard against unmount by
  // capturing a `cancelled` flag in the closure.
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'pending', svg: '', error: null });
    void (async (): Promise<void> => {
      try {
        const api = await loadMermaid();
        api.initialize({
          startOnLoad: false,
          theme,
          securityLevel: 'strict',
          flowchart: { useMaxWidth: true, htmlLabels: false },
          fontFamily: 'Inter, system-ui, sans-serif',
        });
        const { svg } = await api.render(id, code);
        if (cancelled) return;
        setState({ status: 'ready', svg, error: null });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: 'error', svg: '', error: message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, theme, id]);

  const openFullscreen = useCallback(() => {
    if (state.status === 'ready') setFullscreen(true);
  }, [state.status]);

  const closeFullscreen = useCallback(() => setFullscreen(false), []);

  if (state.status === 'error') {
    return (
      <div className={styles.errorRoot} data-testid="mermaid-error">
        <div className={styles.errorHeader}>
          <span className={styles.errorBadge}>Invalid Mermaid</span>
          <span className={styles.errorMessage} title={state.error ?? ''}>
            {state.error ?? 'render failed'}
          </span>
        </div>
        <pre className={styles.errorPre}>
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  if (state.status === 'pending') {
    return (
      <div className={styles.pendingRoot} data-testid="mermaid-pending">
        <span className={styles.pendingLabel}>Loading diagram…</span>
      </div>
    );
  }

  // SVG is produced by mermaid which we trust — but `securityLevel:
  // 'strict'` already strips foreign HTML labels, so dangerouslySet is
  // bounded to the SVG namespace.
  return (
    <>
      <div className={styles.root} data-testid="mermaid-block">
        <div className={styles.header}>
          <span className={styles.label}>mermaid</span>
          <button
            type="button"
            className={styles.expandBtn}
            onClick={openFullscreen}
            aria-label="Open fullscreen"
            title="Open fullscreen"
          >
            ⤢
          </button>
        </div>
        <button
          type="button"
          className={styles.svgWrap}
          onClick={openFullscreen}
          aria-label="Open mermaid diagram fullscreen"
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      </div>
      {fullscreen && (
        <FullscreenOverlay svg={state.svg} onClose={closeFullscreen} />
      )}
    </>
  );
}

interface OverlayProps {
  readonly svg: string;
  readonly onClose: () => void;
}

function FullscreenOverlay({ svg, onClose }: OverlayProps): JSX.Element {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onWheel = useCallback((e: ReactWheelEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setScale((s) => Math.max(0.2, Math.min(8, s * delta)));
  }, []);

  const onMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>): void => {
      dragRef.current = { x: e.clientX, y: e.clientY, tx, ty };
    },
    [tx, ty],
  );
  const onMouseMove = useCallback((e: ReactMouseEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (d === null) return;
    setTx(d.tx + (e.clientX - d.x));
    setTy(d.ty + (e.clientY - d.y));
  }, []);
  const onMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      data-testid="mermaid-overlay"
    >
      <div
        className={styles.overlayCanvas}
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        <div
          className={styles.overlaySvg}
          style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <button
        type="button"
        className={styles.overlayClose}
        onClick={onClose}
        aria-label="Close"
      >
        ✕
      </button>
    </div>
  );
}

export const MermaidBlock = memo(MermaidBlockImpl);
