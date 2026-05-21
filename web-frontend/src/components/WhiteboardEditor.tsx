/**
 * WhiteboardEditor — the lazy-loaded tldraw wrapper.
 *
 * This file is the dynamic-import target of `Whiteboard.tsx`. Putting
 * the tldraw + tldraw.css imports in their own module guarantees vite
 * emits a single `WhiteboardEditor-<hash>.js` chunk for the entire
 * drawing runtime, isolated from the chat-only initial chunk.
 *
 * The wrapper exposes a tiny imperative handle via `onMount` rather
 * than ref-forwarding so the outer Whiteboard component never needs
 * to import tldraw types (those would re-pull the eager chunk).
 */

import { useCallback, useEffect, useRef, type JSX } from 'react';
import {
  Tldraw,
  type Editor,
  type TLUiOverrides,
} from 'tldraw';
import 'tldraw/tldraw.css';

import type { Theme } from '../state/store';

import type {
  WhiteboardEditorHandle,
  WhiteboardExport,
} from './Whiteboard';

export interface WhiteboardEditorProps {
  /**
   * Stable per-session persistence key. tldraw automatically writes to
   * IndexedDB under this name and rehydrates on remount.
   */
  persistenceKey: string;
  /** Current LocalCode theme — mirrored into tldraw's user preferences. */
  theme: Theme;
  onMount: (handle: WhiteboardEditorHandle) => void;
  onUnmount: () => void;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Unexpected reader result'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = (): void => reject(reader.error ?? new Error('Read failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Stripped-down UI override set: hide the share + debug panels we don't
 * want surfaced in an embedded panel context. tldraw still renders the
 * full styled toolbar inside the canvas — our outer toolbar coexists
 * above it.
 */
const uiOverrides: TLUiOverrides = {
  actions(_editor, actions) {
    return actions;
  },
};

export function WhiteboardEditor(props: WhiteboardEditorProps): JSX.Element {
  const { persistenceKey, theme, onMount, onUnmount } = props;
  const editorRef = useRef<Editor | null>(null);
  // Stash a ref to the mount callback so we don't re-publish the handle
  // on every prop change — tldraw's `onMount` only fires once.
  const onMountRef = useRef(onMount);
  onMountRef.current = onMount;
  const onUnmountRef = useRef(onUnmount);
  onUnmountRef.current = onUnmount;

  // Tear down: clear the editor reference + notify the parent so the
  // toolbar buttons disable until a new editor mounts (e.g. when the
  // user switches sessions and persistenceKey flips).
  useEffect(() => {
    return () => {
      editorRef.current = null;
      onUnmountRef.current();
    };
  }, []);

  // Mirror the LocalCode theme into tldraw's user preferences whenever
  // it changes after mount. tldraw stores this in its own user prefs DB
  // so it persists across reloads independent of our store.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null) return;
    editor.user.updateUserPreferences({ colorScheme: theme });
  }, [theme]);

  const handleMount = useCallback(
    (editor: Editor): void => {
      editorRef.current = editor;
      // Seed the initial theme before publishing the handle so the
      // first paint matches LocalCode's dark/light mode.
      editor.user.updateUserPreferences({ colorScheme: theme });
      const handle: WhiteboardEditorHandle = {
        clear: (): void => {
          const ed = editorRef.current;
          if (ed === null) return;
          const ids = [...ed.getCurrentPageShapeIds()];
          if (ids.length === 0) return;
          ed.deleteShapes(ids);
        },
        undo: (): void => {
          editorRef.current?.undo();
        },
        redo: (): void => {
          editorRef.current?.redo();
        },
        selectTool: (tool): void => {
          const ed = editorRef.current;
          if (ed === null) return;
          // tldraw v5 tool ids: 'draw' (pencil) and 'eraser'.
          ed.setCurrentTool(tool);
        },
        exportPng: async (): Promise<WhiteboardExport | null> => {
          const ed = editorRef.current;
          if (ed === null) return null;
          const shapeIds = [...ed.getCurrentPageShapeIds()];
          if (shapeIds.length === 0) return null;
          const result = await ed.toImage(shapeIds, {
            format: 'png',
            background: true,
            scale: 2,
            padding: 16,
          });
          const base64 = await blobToBase64(result.blob);
          return {
            base64,
            width: result.width,
            height: result.height,
            sizeBytes: result.blob.size,
          };
        },
      };
      onMountRef.current(handle);
    },
    [theme],
  );

  return (
    <Tldraw
      persistenceKey={persistenceKey}
      onMount={handleMount}
      overrides={uiOverrides}
      colorScheme={theme}
    />
  );
}
