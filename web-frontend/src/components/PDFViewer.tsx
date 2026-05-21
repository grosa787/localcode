/**
 * PDFViewer — modal that previews a PDF by page (thumbnail + extracted
 * text), lets the user select which pages to attach, and emits the
 * resulting `@pdf:<path>:pages=<spec>` reference back to the Composer.
 *
 * Rendering pipeline:
 *   1. Reads the file via the supplied ArrayBuffer (the Composer hands it
 *      over after the drop / paste event).
 *   2. `pdfjs-dist` parses the document; each page is rendered to a
 *      <canvas> at a small DPR-aware scale (thumbnail).
 *   3. Per-page text is extracted via `getTextContent()` and displayed in
 *      the right pane so the user can verify content before committing.
 *
 * Errors short-circuit to an inline error block — the modal stays open so
 * the user can cancel and try again.
 *
 * Note: rendering is intentionally optional. Sites where canvas support is
 * unavailable (jsdom in tests) fall back to a text-only preview by
 * detecting the absence of `HTMLCanvasElement` and skipping `page.render`.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';

import { Modal, ModalBody, ModalFooter } from './Modal';

import styles from './PDFViewer.module.css';

export interface PDFViewerProps {
  /** Display name of the source file. Used in the title bar. */
  fileName: string;
  /**
   * Logical path to embed in the `@pdf:` reference token. Usually the
   * project-relative path of the dropped file (when the file lives in
   * the workspace) or the basename for ad-hoc uploads.
   */
  filePath: string;
  /** Raw PDF bytes. */
  data: ArrayBuffer;
  /** True while the host wants the modal visible. */
  open: boolean;
  /** Close handler (X / ESC / backdrop / Cancel). */
  onClose: () => void;
  /**
   * Confirm handler. Receives the `pages` spec string (e.g. `'1-3,5'`)
   * or `'all'` when no individual selection was made. The host renders
   * the resulting `@pdf:<filePath>:pages=<spec>` token in the Composer.
   */
  onConfirm: (pagesSpec: string) => void;
  /**
   * Test seam — when supplied, replaces the default dynamic
   * `pdfjs-dist` import. Lets unit tests inject a deterministic stub.
   */
  pdfjsLoader?: () => Promise<PdfjsModule>;
}

export interface PdfjsTextItem {
  readonly str?: unknown;
  readonly hasEOL?: unknown;
}

export interface PdfjsPage {
  getTextContent(): Promise<{ items: ReadonlyArray<PdfjsTextItem> }>;
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }): { promise: Promise<void> };
}

export interface PdfjsDocument {
  readonly numPages: number;
  getPage(n: number): Promise<PdfjsPage>;
  destroy(): Promise<void>;
}

export interface PdfjsModule {
  getDocument(src: { data: Uint8Array; isEvalSupported: boolean; disableFontFace: boolean; useSystemFonts: boolean }): {
    promise: Promise<PdfjsDocument>;
  };
  GlobalWorkerOptions: { workerSrc: string };
}

interface PageEntry {
  page: number;
  text: string;
}

/**
 * Compact a sorted list of unique page numbers into a `pages` spec
 * string. Adjacent runs collapse to ranges. e.g. `[1,2,3,5] → "1-3,5"`.
 */
export function compactPagesSpec(pages: ReadonlyArray<number>): string {
  if (pages.length === 0) return '';
  const sorted = [...pages].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const v = sorted[i];
    if (v === undefined || prev === undefined || start === undefined) continue;
    if (v === prev + 1) {
      prev = v;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = v;
    prev = v;
  }
  if (start !== undefined && prev !== undefined) {
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
  }
  return parts.join(',');
}

/** Joins pdf.js text items into a single string. */
export function joinPdfTextItems(items: ReadonlyArray<PdfjsTextItem>): string {
  let out = '';
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    if (typeof item.str !== 'string') continue;
    out += item.str;
    if (item.hasEOL === true) out += '\n';
  }
  return out.trim();
}

async function defaultPdfjsLoader(): Promise<PdfjsModule> {
  // Vite resolves the worker via its bundler. We use the legacy build for
  // wider compatibility; the worker URL is set once per module load.
  const mod = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule;
  if (mod.GlobalWorkerOptions.workerSrc.length === 0) {
    // Worker URL must be a string. We use the static asset path the
    // bundler resolves at build time; missing-worker is non-fatal — pdf.js
    // falls back to in-thread parsing which is slower but correct.
    try {
      const workerUrl = new URL(
        'pdfjs-dist/legacy/build/pdf.worker.mjs',
        import.meta.url,
      ).href;
      mod.GlobalWorkerOptions.workerSrc = workerUrl;
    } catch {
      // Cross-origin or test environment — leave blank, pdfjs handles it.
    }
  }
  return mod;
}

export function PDFViewer(props: PDFViewerProps): JSX.Element | null {
  const { fileName, data, open, onClose, onConfirm, pdfjsLoader } = props;

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState<PageEntry[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [activePage, setActivePage] = useState<number>(1);
  const docRef = useRef<PdfjsDocument | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Reset internal state every time the modal opens with new data.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPages([]);
    setSelected(new Set());
    setActivePage(1);

    const loader = pdfjsLoader ?? defaultPdfjsLoader;
    loader()
      .then(async (mod) => {
        if (cancelled) return;
        const task = mod.getDocument({
          data: new Uint8Array(data),
          isEvalSupported: false,
          disableFontFace: true,
          useSystemFonts: false,
        });
        const doc = await task.promise;
        if (cancelled) {
          await doc.destroy().catch(() => undefined);
          return;
        }
        docRef.current = doc;
        const out: PageEntry[] = [];
        for (let i = 1; i <= doc.numPages; i += 1) {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          out.push({ page: i, text: joinPdfTextItems(content.items) });
        }
        if (!cancelled) {
          setPages(out);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(`Failed to parse PDF: ${message}`);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      const doc = docRef.current;
      docRef.current = null;
      if (doc !== null) {
        doc.destroy().catch(() => undefined);
      }
    };
  }, [open, data, pdfjsLoader]);

  // Render the active page to the canvas (skipped in jsdom / when 2D
  // context is unavailable). All failures are absorbed silently — the
  // text pane remains the canonical preview.
  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (doc === null || canvas === null) return;
    if (typeof window === 'undefined') return;
    if (typeof (canvas as HTMLCanvasElement).getContext !== 'function') return;

    let cancelled = false;
    (async () => {
      let ctx: CanvasRenderingContext2D | null = null;
      try {
        ctx = canvas.getContext('2d');
      } catch {
        return;
      }
      if (ctx === null) return;
      try {
        const page = await doc.getPage(activePage);
        const viewport = page.getViewport({ scale: 1.2 });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        if (cancelled) return;
        await page.render({ canvasContext: ctx, viewport }).promise;
      } catch {
        // Ignore render failures — the text pane still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePage, pages.length]);

  const togglePage = useCallback((p: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(pages.map((p) => p.page)));
  }, [pages]);

  const clearAll = useCallback(() => {
    setSelected(new Set());
  }, []);

  const handleAttach = useCallback(() => {
    const spec =
      selected.size === 0 || selected.size === pages.length
        ? 'all'
        : compactPagesSpec([...selected]);
    onConfirm(spec);
  }, [selected, pages.length, onConfirm]);

  const activeText = useMemo(() => {
    const entry = pages.find((p) => p.page === activePage);
    return entry?.text ?? '';
  }, [pages, activePage]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={fileName}
      ariaLabel={`PDF preview: ${fileName}`}
      size="xl"
    >
      <ModalBody>
        {loading ? (
          <div className={styles.status} role="status">
            Parsing PDF…
          </div>
        ) : null}
        {error !== null ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}
        {!loading && error === null ? (
          <div className={styles.layout}>
            <div
              className={styles.pageList}
              role="listbox"
              aria-label="PDF pages"
              aria-multiselectable="true"
            >
              {pages.map((entry) => {
                const isSelected = selected.has(entry.page);
                const isActive = entry.page === activePage;
                return (
                  <div
                    key={entry.page}
                    className={styles.pageRow}
                    data-active={isActive ? 'true' : 'false'}
                    data-selected={isSelected ? 'true' : 'false'}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => setActivePage(entry.page)}
                  >
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      checked={isSelected}
                      onChange={() => togglePage(entry.page)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Select page ${entry.page}`}
                    />
                    <span className={styles.pageLabel}>Page {entry.page}</span>
                    <span className={styles.pageSnippet}>
                      {entry.text.slice(0, 60)}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className={styles.preview}>
              <canvas
                ref={canvasRef}
                className={styles.canvas}
                aria-label={`Page ${activePage} thumbnail`}
              />
              <pre className={styles.text}>{activeText}</pre>
            </div>
          </div>
        ) : null}
      </ModalBody>
      <ModalFooter>
        <div className={styles.footerActions}>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={selectAll}
            disabled={pages.length === 0}
          >
            Select all
          </button>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={clearAll}
            disabled={selected.size === 0}
          >
            Clear
          </button>
          <div className={styles.spacer} />
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={handleAttach}
            disabled={loading || error !== null}
          >
            Attach selected pages
          </button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
