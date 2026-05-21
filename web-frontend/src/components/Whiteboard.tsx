/**
 * Whiteboard — tldraw-backed drawing surface for the web SPA.
 *
 * Mounted into the right dock as the `whiteboard` panel. The user can
 * sketch diagrams / UI mockups and then click "Send to chat" which
 * exports the current page as a PNG and pushes it into the Composer's
 * image-attachment lane via the shared `whiteboardPendingImage` slot
 * in the Zustand store.
 *
 * Design notes:
 *   - tldraw is dynamically imported (React.lazy) so its 12 MB unpacked
 *     bundle never ships in the chat-only initial chunk. The first time
 *     the panel becomes visible (i.e. the right-dock body is rendered),
 *     vite emits + loads a separate `Whiteboard-<hash>.js` chunk.
 *   - Per-session persistence is delegated to tldraw's own
 *     `persistenceKey` prop, which writes to IndexedDB (`tldraw.<key>`).
 *     We compose the key as `localcode.web.whiteboard.<sessionId|none>`
 *     so each session keeps its own drawing.
 *   - Theme integration: tldraw owns a `colorScheme` user-preference
 *     (`light` | `dark`); we mirror it from the LocalCode store's
 *     `theme` whenever the editor mounts and whenever the user toggles.
 *   - Send-to-chat: tldraw v5's `editor.toImage(shapeIds, opts)` returns
 *     `{ blob, width, height }` — we PNG-encode the page, base64 it,
 *     then publish the result into `whiteboardPendingImage`. The
 *     Composer subscribes to that slot and inlines the bytes as an
 *     image attachment (re-using the existing multimodal lane).
 *   - Vision warning: if the active model can't accept images, we
 *     surface a non-blocking warning toast at send time so users don't
 *     burn a turn sending a drawing into a text-only model.
 */

import {
  Suspense,
  lazy,
  useCallback,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';

import { useT } from '../i18n';
import { supportsVision } from '../util/vision-capability';
import { Eraser, Pencil, Redo2, Send, Trash2, Undo2 } from '../icons';
import {
  type WhiteboardPendingImage,
  useStore,
} from '../state/store';

import styles from './Whiteboard.module.css';

// Lazy-load the entire tldraw module so its CSS + IndexedDB driver +
// shape runtime are only fetched when the user actually opens the
// whiteboard panel. We must also lazy-load the CSS via a side-effect
// import inside the lazy chunk (see WhiteboardEditor below).
const WhiteboardEditor = lazy(async () => {
  const mod = await import('./WhiteboardEditor');
  return { default: mod.WhiteboardEditor };
});

/**
 * Public surface — no required props; the component drives itself from
 * the store + i18n + REST. The container wraps a Suspense boundary so
 * the chunk fetch shows a tiny loading state instead of blank space.
 */
export function Whiteboard(): JSX.Element {
  const t = useT();
  const theme = useStore((s) => s.theme);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const activeBackend = useStore((s) => s.activeBackend);
  const currentModel = useStore((s) => s.currentModel);
  const pushToast = useStore((s) => s.pushToast);
  const setPendingImage = useStore((s) => s.setWhiteboardPendingImage);

  // Imperative handle published by the lazy editor — lets the toolbar
  // here drive the embedded editor without lifting tldraw state out.
  // The ref is reset on session/theme remount so we never hold a stale
  // editor reference.
  const handleRef = useRef<WhiteboardEditorHandle | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [busy, setBusy] = useState(false);

  // Pick a persistence key per session so each chat owns its drawing.
  const persistenceKey = useMemo(
    () => `localcode.web.whiteboard.${activeSessionId ?? 'none'}`,
    [activeSessionId],
  );

  const onEditorMount = useCallback((handle: WhiteboardEditorHandle) => {
    handleRef.current = handle;
    setEditorReady(true);
  }, []);

  const onEditorUnmount = useCallback(() => {
    handleRef.current = null;
    setEditorReady(false);
  }, []);

  const clearCanvas = useCallback(() => {
    handleRef.current?.clear();
  }, []);
  const undo = useCallback(() => {
    handleRef.current?.undo();
  }, []);
  const redo = useCallback(() => {
    handleRef.current?.redo();
  }, []);
  const selectDraw = useCallback(() => {
    handleRef.current?.selectTool('draw');
  }, []);
  const selectErase = useCallback(() => {
    handleRef.current?.selectTool('eraser');
  }, []);

  const sendToChat = useCallback(async () => {
    const handle = handleRef.current;
    if (handle === null) return;
    if (busy) return;
    if (currentModel === null || currentModel.length === 0) {
      pushToast({
        level: 'warning',
        message: t('whiteboard.noModel'),
      });
      return;
    }
    if (!supportsVision(activeBackend ?? undefined, currentModel)) {
      pushToast({
        level: 'warning',
        message: t('whiteboard.noVision', { model: currentModel }),
      });
      // Continue anyway — the user has been warned. Most providers will
      // simply ignore the image; a few will return an error which the
      // user can retry from.
    }
    setBusy(true);
    pushToast({
      level: 'info',
      message: t('whiteboard.exporting'),
      duration: 2000,
    });
    try {
      const exported = await handle.exportPng();
      if (exported === null) {
        pushToast({
          level: 'warning',
          message: t('whiteboard.nothingToSend'),
        });
        return;
      }
      const pending: WhiteboardPendingImage = {
        base64: exported.base64,
        mimeType: 'image/png',
        width: exported.width,
        height: exported.height,
        sizeBytes: exported.sizeBytes,
        name: `whiteboard-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
      };
      setPendingImage(pending);
      pushToast({
        level: 'success',
        message: t('whiteboard.sent'),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast({
        level: 'error',
        message: t('whiteboard.exportFailed', { message }),
      });
    } finally {
      setBusy(false);
    }
  }, [
    activeBackend,
    busy,
    currentModel,
    pushToast,
    setPendingImage,
    t,
  ]);

  return (
    <div
      className={styles.container ?? ''}
      data-testid="whiteboard"
      aria-label={t('whiteboard.aria')}
    >
      <div className={styles.toolbar ?? ''} role="toolbar">
        <div className={styles.toolbarGroup ?? ''}>
          <button
            type="button"
            className={styles.toolbarBtn ?? ''}
            onClick={selectDraw}
            disabled={!editorReady}
            title={t('whiteboard.tools.draw')}
            data-testid="whiteboard-tool-draw"
          >
            <Pencil size={14} strokeWidth={1.6} />
          </button>
          <button
            type="button"
            className={styles.toolbarBtn ?? ''}
            onClick={selectErase}
            disabled={!editorReady}
            title={t('whiteboard.tools.erase')}
            data-testid="whiteboard-tool-erase"
          >
            <Eraser size={14} strokeWidth={1.6} />
          </button>
          <button
            type="button"
            className={styles.toolbarBtn ?? ''}
            onClick={undo}
            disabled={!editorReady}
            title={t('whiteboard.tools.undo')}
            data-testid="whiteboard-tool-undo"
          >
            <Undo2 size={14} strokeWidth={1.6} />
          </button>
          <button
            type="button"
            className={styles.toolbarBtn ?? ''}
            onClick={redo}
            disabled={!editorReady}
            title={t('whiteboard.tools.redo')}
            data-testid="whiteboard-tool-redo"
          >
            <Redo2 size={14} strokeWidth={1.6} />
          </button>
          <button
            type="button"
            className={styles.toolbarBtn ?? ''}
            onClick={clearCanvas}
            disabled={!editorReady}
            title={t('whiteboard.tools.clear')}
            data-testid="whiteboard-tool-clear"
          >
            <Trash2 size={14} strokeWidth={1.6} />
          </button>
        </div>
        <div className={styles.toolbarGroup ?? ''}>
          <button
            type="button"
            className={styles.sendBtn ?? ''}
            onClick={() => {
              void sendToChat();
            }}
            disabled={!editorReady || busy}
            title={t('whiteboard.send.title')}
            data-testid="whiteboard-send"
          >
            <Send size={13} strokeWidth={1.6} />
            <span>{t('whiteboard.send.label')}</span>
          </button>
        </div>
      </div>
      <div className={styles.canvas ?? ''} data-testid="whiteboard-canvas">
        <Suspense
          fallback={
            <div className={styles.loading ?? ''} data-testid="whiteboard-loading">
              {t('whiteboard.loading')}
            </div>
          }
        >
          <WhiteboardEditor
            persistenceKey={persistenceKey}
            theme={theme}
            onMount={onEditorMount}
            onUnmount={onEditorUnmount}
          />
        </Suspense>
      </div>
    </div>
  );
}

/**
 * Imperative handle published by the lazy `WhiteboardEditor` once
 * tldraw's editor is mounted. Keeping the surface tiny (5 methods)
 * lets the parent drive the toolbar without leaking tldraw types into
 * the eager chunk.
 */
export interface WhiteboardEditorHandle {
  clear: () => void;
  undo: () => void;
  redo: () => void;
  selectTool: (tool: 'draw' | 'eraser') => void;
  /**
   * Export the current page as a PNG. Returns `null` when there is
   * nothing on the canvas.
   */
  exportPng: () => Promise<WhiteboardExport | null>;
}

export interface WhiteboardExport {
  base64: string;
  width: number;
  height: number;
  sizeBytes: number;
}
