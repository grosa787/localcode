/**
 * FilePreview — the right-hand pane in the file browser split.
 *
 * Three render modes keyed off the response shape:
 *   1. `encoding='utf-8'` → `<SyntaxBlock>` with language inferred from
 *      the filename.
 *   2. `encoding='image'` → inline `<img src="data:…;base64,…">`. The
 *      backend caps file size at 1MB before encoding so this stays
 *      cheap.
 *   3. `encoding='binary'` OR HTTP 415 OR HTTP 413 → "Binary file" /
 *      "Too large" placeholder. We never attempt to render binary
 *      content as text.
 *
 * The preview owns its own loading + error state — the parent only
 * passes the `path`, the `fetchFile` thunk, and a close handler.
 * Caching is deliberately absent: previews are cheap and the user
 * almost always reads forward, so keeping the latest fetch fresh is
 * simpler than invalidating a per-file cache.
 */

import { useCallback, useEffect, useState, type JSX } from 'react';

import type { FileReadResponse } from '../../../src/web/protocol/rest-types.js';
import { useT } from '../i18n';
import { Copy, Check, Loader2, X, FileImage as FileImageIcon } from '../icons';
import { formatBytes, inferLanguageForSyntax, isImageFilename } from '../util/file-icons';

import { EmptyState } from './EmptyState';
import { SyntaxBlock } from './SyntaxBlock';

import styles from './FilePreview.module.css';

export interface FilePreviewProps {
  /** Path relative to the project root (e.g. `src/foo.ts`). */
  path: string;
  /** Absolute project root — used for "Copy absolute path". */
  rootPath: string;
  /** Project id used in error messages (currently unused but kept for callers). */
  projectId: string;
  /** Thunk that resolves to the file contents, or rejects on error. */
  fetchFile: (path: string) => Promise<FileReadResponse>;
  onClose: () => void;
}

interface FetchState {
  status: 'loading' | 'ok' | 'binary' | 'too-large' | 'error';
  data: FileReadResponse | null;
  errorMessage: string | null;
  binarySize: number | null;
}

const INITIAL: FetchState = {
  status: 'loading',
  data: null,
  errorMessage: null,
  binarySize: null,
};

export function FilePreview(props: FilePreviewProps): JSX.Element {
  const t = useT();
  const [state, setState] = useState<FetchState>(INITIAL);
  const [copied, setCopied] = useState(false);
  const { path, rootPath, fetchFile, onClose } = props;

  // Re-fetch whenever the active path changes.
  useEffect(() => {
    let cancelled = false;
    setState(INITIAL);
    fetchFile(path).then(
      (res) => {
        if (cancelled) return;
        if (res.encoding === 'binary') {
          setState({
            status: 'binary',
            data: res,
            errorMessage: null,
            binarySize: res.size,
          });
          return;
        }
        setState({
          status: 'ok',
          data: res,
          errorMessage: null,
          binarySize: null,
        });
      },
      (err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        // The REST client throws `RestError(status, body)`; the message
        // is `HTTP 415: …` which we sniff for to render the proper
        // placeholder instead of an angry red error row.
        if (message.startsWith('HTTP 415')) {
          setState({
            status: 'binary',
            data: null,
            errorMessage: null,
            binarySize: null,
          });
          return;
        }
        if (message.startsWith('HTTP 413')) {
          setState({
            status: 'too-large',
            data: null,
            errorMessage: null,
            binarySize: null,
          });
          return;
        }
        setState({
          status: 'error',
          data: null,
          errorMessage: message,
          binarySize: null,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, fetchFile]);

  const onCopyAbsolute = useCallback(() => {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
      return;
    }
    const abs = `${rootPath.replace(/\/+$/, '')}/${path}`;
    navigator.clipboard.writeText(abs).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => {
        /* clipboard rejected — silent */
      },
    );
  }, [rootPath, path]);

  const filename = path.split('/').pop() ?? path;
  const isImg = isImageFilename(filename);

  return (
    <section className={styles.root} aria-label={t('fileBrowser.noSelection')}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.filename} title={path}>
            {filename}
          </span>
          {state.data?.size !== undefined ? (
            <span className={styles.meta}>{formatBytes(state.data.size)}</span>
          ) : null}
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onCopyAbsolute}
            title={t('fileBrowser.copyPath')}
            aria-label={t('fileBrowser.copyPath')}
          >
            {copied ? (
              <Check size={14} strokeWidth={1.5} />
            ) : (
              <Copy size={14} strokeWidth={1.5} />
            )}
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onClose}
            title={t('fileBrowser.preview.close')}
            aria-label={t('fileBrowser.preview.close')}
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
      </header>
      <div className={styles.body}>
        {state.status === 'loading' ? (
          <div className={styles.loading}>
            <Loader2 size={14} strokeWidth={1.5} className={styles.spin} />
            <span>{t('fileBrowser.reading', { path })}</span>
          </div>
        ) : state.status === 'error' ? (
          <div className={styles.error}>{state.errorMessage}</div>
        ) : state.status === 'too-large' ? (
          <EmptyState
            icon={FileImageIcon}
            title={t('fileBrowser.preview.tooLarge', {
              size: state.data !== null ? formatBytes(state.data.size) : '?',
            })}
          />
        ) : state.status === 'binary' ? (
          <EmptyState
            icon={FileImageIcon}
            title={t('fileBrowser.preview.binary', {
              size:
                state.binarySize !== null
                  ? formatBytes(state.binarySize)
                  : '?',
            })}
          />
        ) : isImg && state.data?.encoding === 'image' ? (
          <div className={styles.imageWrap}>
            <img
              className={styles.image}
              src={`data:${state.data.mimeType ?? 'image/png'};base64,${state.data.content}`}
              alt={filename}
            />
            <span className={styles.imageMeta}>
              {t('fileBrowser.preview.image', {
                size: formatBytes(state.data.size),
              })}
            </span>
          </div>
        ) : state.data !== null ? (
          <SyntaxBlock
            language={inferLanguageForSyntax(filename)}
            code={state.data.content}
          />
        ) : null}
      </div>
    </section>
  );
}
