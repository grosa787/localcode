/**
 * BrowserPanel — floating right-side viewer for the model's Chromium
 * sandbox. Renders a live JPEG screencast on a <canvas>, overlays a
 * synthetic cursor for model actions, and forwards user input
 * (click/scroll/key) back to the backend over the existing WS.
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
  type WheelEvent as ReactWheelEvent,
} from 'react';

import type {
  BrowserCursorEvent,
  BrowserStatus,
} from '../state/store';
import { useApiClients } from '../App';
import { useT } from '../i18n';
import type { TranslationKey } from '../i18n';
import { useStore } from '../state/store';
import { Globe, X } from '../icons';

import { BrowserActionLog } from './BrowserActionLog';
import styles from './BrowserPanel.module.css';

const FALLBACK_W = 1280;
const FALLBACK_H = 720;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function statusLabelKey(status: BrowserStatus): TranslationKey {
  switch (status) {
    case 'idle':
      return 'browser.status.idle';
    case 'starting':
      return 'browser.status.starting';
    case 'ready':
      return 'browser.status.ready';
    case 'navigating':
      return 'browser.status.navigating';
    case 'closed':
      return 'browser.status.closed';
    case 'error':
      return 'browser.status.error';
  }
}

function statusClass(status: BrowserStatus): string | undefined {
  switch (status) {
    case 'ready':
      return styles.statusReady;
    case 'error':
    case 'closed':
      return styles.statusError;
    case 'starting':
    case 'navigating':
      return styles.statusBusy;
    default:
      return styles.statusIdle;
  }
}

export function BrowserPanel(): JSX.Element | null {
  const t = useT();
  const browser = useStore((s) => s.browser);
  const closeBrowserPanel = useStore((s) => s.closeBrowserPanel);
  const dequeueBrowserCursor = useStore((s) => s.dequeueBrowserCursor);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const connectionStatus = useStore((s) => s.connection.status);
  const { wsSend } = useApiClients();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const [activeCursor, setActiveCursor] =
    useState<BrowserCursorEvent | null>(null);
  const [ripple, setRipple] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );

  // Lazily build the reusable Image instance.
  if (imgRef.current === null && typeof window !== 'undefined') {
    imgRef.current = new Image();
  }

  // Draw frame on update.
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    const frame = browser.latestFrame;
    if (canvas === null || img === null || frame === null) return;
    if (canvas.width !== frame.width) canvas.width = frame.width;
    if (canvas.height !== frame.height) canvas.height = frame.height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const onLoad = (): void => {
      try {
        ctx.drawImage(img, 0, 0, frame.width, frame.height);
      } catch {
        /* drawImage can throw if the image was replaced before load */
      }
    };
    img.onload = onLoad;
    img.src = `data:image/jpeg;base64,${frame.jpegBase64}`;
  }, [browser.latestFrame]);

  // Cursor animation queue: process serially.
  useEffect(() => {
    if (activeCursor !== null) return;
    const next = browser.cursorQueue[0];
    if (next === undefined) return;
    const reduced = prefersReducedMotion();
    setActiveCursor(next);

    const cursor = cursorRef.current;
    const frame = browser.latestFrame;
    const w = frame !== null ? frame.width : FALLBACK_W;
    const h = frame !== null ? frame.height : FALLBACK_H;

    if (cursor !== null) {
      // Snap to start position (no transition), then trigger move.
      cursor.style.transition = 'none';
      cursor.style.left = `${(next.fromX / w) * 100}%`;
      cursor.style.top = `${(next.fromY / h) * 100}%`;
      // Force reflow so the next assignment animates.
      void cursor.offsetWidth;
      const dur = reduced ? 0 : Math.max(0, next.durationMs);
      cursor.style.transition = `left ${dur}ms ease-out, top ${dur}ms ease-out`;
      cursor.style.left = `${(next.toX / w) * 100}%`;
      cursor.style.top = `${(next.toY / h) * 100}%`;
    }

    const ms = reduced ? 0 : Math.max(0, next.durationMs);
    const t = window.setTimeout(() => {
      if (next.action === 'click') {
        setRipple({
          id: next.id,
          x: (next.toX / w) * 100,
          y: (next.toY / h) * 100,
        });
        window.setTimeout(() => {
          setRipple((r) => (r !== null && r.id === next.id ? null : r));
        }, 360);
      }
      dequeueBrowserCursor(next.id);
      setActiveCursor(null);
    }, ms + 16);
    return () => window.clearTimeout(t);
  }, [
    activeCursor,
    browser.cursorQueue,
    browser.latestFrame,
    dequeueBrowserCursor,
  ]);

  const sendIfActive = useCallback(
    (build: (sid: string) => Parameters<typeof wsSend>[0] | null) => {
      if (activeSessionId === null) return;
      const msg = build(activeSessionId);
      if (msg !== null) wsSend(msg);
    },
    [activeSessionId, wsSend],
  );

  const handleCanvasClick = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      const frame = browser.latestFrame;
      if (canvas === null || frame === null) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = ((e.clientX - rect.left) * frame.width) / rect.width;
      const y = ((e.clientY - rect.top) * frame.height) / rect.height;
      const button: 'left' | 'right' = e.button === 2 ? 'right' : 'left';
      sendIfActive((sessionId) => ({
        type: 'browser_user_click',
        sessionId,
        x: Math.round(x),
        y: Math.round(y),
        button,
      }));
    },
    [browser.latestFrame, sendIfActive],
  );

  const handleCanvasWheel = useCallback(
    (e: ReactWheelEvent<HTMLCanvasElement>) => {
      sendIfActive((sessionId) => ({
        type: 'browser_user_scroll',
        sessionId,
        deltaY: e.deltaY,
      }));
    },
    [sendIfActive],
  );

  const handleCanvasKey = useCallback(
    (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
      const mods: ('shift' | 'ctrl' | 'alt' | 'meta')[] = [];
      if (e.shiftKey) mods.push('shift');
      if (e.ctrlKey) mods.push('ctrl');
      if (e.altKey) mods.push('alt');
      if (e.metaKey) mods.push('meta');
      sendIfActive((sessionId) => ({
        type: 'browser_user_key',
        sessionId,
        key: e.key,
        ...(mods.length > 0 ? { modifiers: mods } : {}),
      }));
      e.preventDefault();
    },
    [sendIfActive],
  );

  const handleClose = useCallback(() => {
    if (activeSessionId !== null) {
      wsSend({ type: 'browser_close_panel', sessionId: activeSessionId });
    }
    closeBrowserPanel();
  }, [activeSessionId, wsSend, closeBrowserPanel]);

  const aspectStyle = useMemo<React.CSSProperties>(() => {
    const frame = browser.latestFrame;
    const w = frame !== null ? frame.width : FALLBACK_W;
    const h = frame !== null ? frame.height : FALLBACK_H;
    return { aspectRatio: `${w} / ${h}` };
  }, [browser.latestFrame]);

  if (!browser.open) return null;

  const showStarting = browser.status === 'starting';
  const showError = browser.status === 'error';
  const showIdleHint =
    browser.status === 'idle' && browser.latestFrame === null;
  const reconnecting =
    connectionStatus === 'reconnecting' || connectionStatus === 'closed';

  const displayStatus: BrowserStatus = browser.status;
  const displayLabel = reconnecting
    ? t('browser.status.reconnecting')
    : t(statusLabelKey(displayStatus));

  return (
    <aside className={styles.panel} role="complementary" aria-label={t('browser.aria')}>
      <header className={styles.header}>
        <Globe size={14} strokeWidth={1.5} />
        <span className={styles.url} title={browser.url ?? ''}>
          {browser.url ?? browser.title ?? 'about:blank'}
        </span>
        <span
          className={`${styles.status} ${
            reconnecting ? styles.statusBusy : statusClass(displayStatus) ?? ''
          }`}
        >
          {displayLabel}
        </span>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={handleClose}
          aria-label={t('browser.close')}
          title={t('common.close')}
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </header>

      <div className={styles.canvasWrap} style={aspectStyle}>
        {browser.latestFrame !== null ? (
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            tabIndex={0}
            onClick={handleCanvasClick}
            onContextMenu={(e) => e.preventDefault()}
            onWheel={handleCanvasWheel}
            onKeyDown={handleCanvasKey}
          />
        ) : (
          <div className={styles.placeholder}>
            {showStarting ? (
              <span>{t('browser.placeholder.starting')}</span>
            ) : showError ? (
              <span className={styles.errorText}>
                {browser.errorMessage ?? t('browser.placeholder.error')}
              </span>
            ) : showIdleHint ? (
              <span className={styles.hint}>
                {t('browser.placeholder.idle')}
              </span>
            ) : (
              <span>{t('browser.placeholder.waiting')}</span>
            )}
          </div>
        )}
        {browser.latestFrame !== null ? (
          <div
            ref={cursorRef}
            className={styles.cursor}
            aria-hidden="true"
          />
        ) : null}
        {ripple !== null ? (
          <div
            key={ripple.id}
            className={styles.ripple}
            style={{ left: `${ripple.x}%`, top: `${ripple.y}%` }}
            aria-hidden="true"
          />
        ) : null}
      </div>

      <div className={styles.logWrap}>
        <BrowserActionLog entries={browser.console} />
      </div>
    </aside>
  );
}
