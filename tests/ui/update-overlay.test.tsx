/**
 * UpdateOverlay — full-screen ink update modal.
 *
 * Covers:
 *   - `truncateBody` pure helper — collapses long bodies, leaves short ones.
 *   - Render contract — header line, body, footer key hint, GitHub URL.
 *   - "Restart to apply" label when `downloaded` is true.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';

import UpdateOverlay, {
  __test__,
  type UpdateOverlayPayload,
} from '@/ui/overlays/UpdateOverlay';

const { truncateBody, MAX_BODY_LINES } = __test__;

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

interface MountResult {
  readonly read: () => string;
  readonly unmount: () => void;
}

function mountOverlay(opts: {
  readonly info: UpdateOverlayPayload;
  readonly downloaded?: boolean;
}): MountResult {
  const buf: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb): void {
      buf.push(Buffer.from(chunk));
      cb();
    },
  });
  (stdout as unknown as { columns: number }).columns = 200;
  (stdout as unknown as { rows: number }).rows = 40;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  const instance = render(
    React.createElement(UpdateOverlay, {
      info: opts.info,
      downloaded: opts.downloaded ?? false,
      onInstall: () => {
        /* no-op */
      },
      onLater: () => {
        /* no-op */
      },
      onSkip: () => {
        /* no-op */
      },
      onClose: () => {
        /* no-op */
      },
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );
  return {
    read: () => stripAnsi(Buffer.concat(buf).toString('utf8')),
    unmount: () => instance.unmount(),
  };
}

beforeAll(() => {
  process.env['FORCE_COLOR'] = '0';
});

function makeInfo(overrides: Partial<UpdateOverlayPayload> = {}): UpdateOverlayPayload {
  return {
    currentVersion: '0.19.0',
    latestVersion: '0.20.0',
    releaseUrl: 'https://github.com/local/code/releases/tag/v0.20.0',
    releaseName: 'Spring polish',
    body: '## Highlights\n- New modal\n- Skip versions\n\n## Fixes\n- A bug',
    ...overrides,
  };
}

describe('truncateBody', () => {
  test('empty body produces a placeholder line', () => {
    expect(truncateBody('')).toEqual(['(no release notes provided)']);
  });

  test('short body returns its lines unchanged', () => {
    const lines = truncateBody('one\ntwo\nthree');
    expect(lines).toEqual(['one', 'two', 'three']);
  });

  test('long body collapses to the max line budget', () => {
    const big = Array.from({ length: 50 }, (_v, i) => `line ${i}`).join('\n');
    const out = truncateBody(big);
    expect(out.length).toBe(MAX_BODY_LINES);
    expect(out[out.length - 1]).toContain('more lines');
  });
});

describe('UpdateOverlay render', () => {
  test('renders the version arrow, release name, body, and footer hint', () => {
    const m = mountOverlay({ info: makeInfo() });
    const out = m.read();
    m.unmount();
    expect(out).toContain('Update available');
    expect(out).toContain('v0.19.0');
    expect(out).toContain('v0.20.0');
    expect(out).toContain('Spring polish');
    expect(out).toContain('## Highlights');
    expect(out).toContain('https://github.com/local/code/releases/tag/v0.20.0');
    expect(out).toContain('i install');
    expect(out).toContain('l later');
    expect(out).toContain('s skip');
    expect(out).toContain('esc dismiss');
  });

  test('shows restart-to-apply when the binary is staged', () => {
    const m = mountOverlay({ info: makeInfo(), downloaded: true });
    const out = m.read();
    m.unmount();
    expect(out).toContain('restart-to-apply');
  });

  test('omits release name when empty', () => {
    const m = mountOverlay({ info: makeInfo({ releaseName: '' }) });
    const out = m.read();
    m.unmount();
    expect(out).not.toContain('Spring polish');
  });
});
