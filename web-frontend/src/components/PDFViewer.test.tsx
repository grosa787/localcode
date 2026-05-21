/**
 * PDFViewer tests — exercises the page list, selection state, and the
 * `pagesSpec` returned to the host on confirm. The actual pdf.js module
 * is replaced with an injected stub so the test stays deterministic and
 * does not need a real worker.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  compactPagesSpec,
  joinPdfTextItems,
  PDFViewer,
  type PdfjsDocument,
  type PdfjsModule,
  type PdfjsPage,
} from './PDFViewer';

afterEach(() => cleanup());

function buildStubModule(numPages: number, perPageText: (n: number) => string): PdfjsModule {
  const pageFor = (n: number): PdfjsPage => ({
    getTextContent: async () => ({
      items: [{ str: perPageText(n), hasEOL: true }],
    }),
    getViewport: () => ({ width: 100, height: 100 }),
    render: () => ({ promise: Promise.resolve() }),
  });
  const doc: PdfjsDocument = {
    numPages,
    getPage: async (n) => pageFor(n),
    destroy: async () => undefined,
  };
  return {
    getDocument: () => ({ promise: Promise.resolve(doc) }),
    GlobalWorkerOptions: { workerSrc: '' },
  };
}

describe('compactPagesSpec', () => {
  test('collapses runs to ranges', () => {
    expect(compactPagesSpec([1, 2, 3, 5])).toBe('1-3,5');
  });
  test('singletons stay as singles', () => {
    expect(compactPagesSpec([1, 3, 5])).toBe('1,3,5');
  });
  test('empty input', () => {
    expect(compactPagesSpec([])).toBe('');
  });
  test('out-of-order input gets sorted', () => {
    expect(compactPagesSpec([5, 1, 2, 4, 3])).toBe('1-5');
  });
});

describe('joinPdfTextItems', () => {
  test('respects hasEOL', () => {
    expect(
      joinPdfTextItems([
        { str: 'a', hasEOL: true },
        { str: 'b' },
      ]),
    ).toBe('a\nb');
  });
  test('skips invalid items', () => {
    const items = [
      { str: 'ok' },
      null,
      { foo: 'bar' },
    ] as unknown as ReadonlyArray<import('./PDFViewer').PdfjsTextItem>;
    expect(joinPdfTextItems(items)).toBe('ok');
  });
});

describe('PDFViewer', () => {
  test('renders nothing when closed', () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const { container } = render(
      <PDFViewer
        fileName="x.pdf"
        filePath="x.pdf"
        data={new ArrayBuffer(0)}
        open={false}
        onClose={onClose}
        onConfirm={onConfirm}
        pdfjsLoader={() => Promise.resolve(buildStubModule(2, (n) => `Page ${n} body`))}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test('renders the page list once loaded', async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(
      <PDFViewer
        fileName="x.pdf"
        filePath="x.pdf"
        data={new ArrayBuffer(0)}
        open={true}
        onClose={onClose}
        onConfirm={onConfirm}
        pdfjsLoader={() => Promise.resolve(buildStubModule(3, (n) => `Body ${n}`))}
      />,
    );
    await waitFor(() => {
      const items = screen.getAllByRole('option');
      expect(items.length).toBe(3);
    });
    // Each row has its own "Page N" label inside.
    expect(screen.getAllByText('Page 1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Page 2').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Page 3').length).toBeGreaterThan(0);
  });

  test('selecting a page checks the box and updates the spec emitted on confirm', async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(
      <PDFViewer
        fileName="x.pdf"
        filePath="x.pdf"
        data={new ArrayBuffer(0)}
        open={true}
        onClose={onClose}
        onConfirm={onConfirm}
        pdfjsLoader={() => Promise.resolve(buildStubModule(4, (n) => `Page ${n}`))}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0);
    });

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.length).toBe(4);
    // Select pages 1, 2, 4 -> spec "1-2,4"
    const b0 = boxes[0];
    const b1 = boxes[1];
    const b3 = boxes[3];
    if (b0 === undefined || b1 === undefined || b3 === undefined) {
      throw new Error('checkbox missing');
    }
    fireEvent.click(b0);
    fireEvent.click(b1);
    fireEvent.click(b3);

    fireEvent.click(screen.getByText('Attach selected pages'));
    expect(onConfirm).toHaveBeenCalledWith('1-2,4');
  });

  test('select all yields "all" spec', async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(
      <PDFViewer
        fileName="x.pdf"
        filePath="x.pdf"
        data={new ArrayBuffer(0)}
        open={true}
        onClose={onClose}
        onConfirm={onConfirm}
        pdfjsLoader={() => Promise.resolve(buildStubModule(3, (n) => `${n}`))}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByText('Select all'));
    fireEvent.click(screen.getByText('Attach selected pages'));
    expect(onConfirm).toHaveBeenCalledWith('all');
  });

  test('confirm with empty selection emits "all"', async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(
      <PDFViewer
        fileName="x.pdf"
        filePath="x.pdf"
        data={new ArrayBuffer(0)}
        open={true}
        onClose={onClose}
        onConfirm={onConfirm}
        pdfjsLoader={() => Promise.resolve(buildStubModule(2, (n) => `${n}`))}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByText('Attach selected pages'));
    expect(onConfirm).toHaveBeenCalledWith('all');
  });

  test('cancel triggers onClose', async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(
      <PDFViewer
        fileName="x.pdf"
        filePath="x.pdf"
        data={new ArrayBuffer(0)}
        open={true}
        onClose={onClose}
        onConfirm={onConfirm}
        pdfjsLoader={() => Promise.resolve(buildStubModule(1, (_n) => 'x'))}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  test('surfaces a friendly error when pdfjs throws', async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const failingLoader = (): Promise<PdfjsModule> =>
      Promise.resolve({
        getDocument: () => ({
          promise: Promise.reject(new Error('boom')),
        }),
        GlobalWorkerOptions: { workerSrc: '' },
      });
    render(
      <PDFViewer
        fileName="x.pdf"
        filePath="x.pdf"
        data={new ArrayBuffer(0)}
        open={true}
        onClose={onClose}
        onConfirm={onConfirm}
        pdfjsLoader={failingLoader}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('boom');
    });
  });
});
