/**
 * Threshold escalation contract for `<StatusPill>` + `<UsageFooter>`.
 *
 * Mirrors `web-frontend/src/components/ProjectBar.tsx`'s `tokenClass`
 * helper so the TUI and the web client agree on what counts as
 * "calm" / "warming up" / "compress incoming":
 *
 *   - < 60%   → green (success)
 *   - 60..85% → yellow (warning)
 *   - >= 85%  → red (danger)
 *
 * The colour picker is a pure helper so we exercise it directly via
 * the `__test__` namespace export. A second block verifies that the
 * UsageFooter consumes the same ladder when it receives a
 * `contextPercent` prop.
 */

import { describe, test, expect } from 'bun:test';

import {
  __test__ as pillTest,
  PILL_WARNING_PCT,
  PILL_DANGER_PCT,
  PILL_COLORS,
} from '@/ui/components/StatusPill';
import { __test__ as footerTest } from '@/ui/components/UsageFooter';

describe('StatusPill — pillColorFor threshold escalation', () => {
  const { pillColorFor } = pillTest;

  test('warning / danger break-points match web ProjectBar', () => {
    // Belt-and-braces — guards against an accidental TUI/web drift.
    expect(PILL_WARNING_PCT).toBe(60);
    expect(PILL_DANGER_PCT).toBe(85);
  });

  test('0% is calm (success/green)', () => {
    expect(pillColorFor(0)).toBe(PILL_COLORS.success);
  });

  test('59.999% — just below warning boundary stays green', () => {
    expect(pillColorFor(59.999)).toBe(PILL_COLORS.success);
  });

  test('exactly 60% — boundary inclusive → yellow', () => {
    expect(pillColorFor(60)).toBe(PILL_COLORS.warning);
  });

  test('60..85% band → yellow', () => {
    expect(pillColorFor(61)).toBe(PILL_COLORS.warning);
    expect(pillColorFor(75)).toBe(PILL_COLORS.warning);
    expect(pillColorFor(84.999)).toBe(PILL_COLORS.warning);
  });

  test('exactly 85% — boundary inclusive → red', () => {
    expect(pillColorFor(85)).toBe(PILL_COLORS.danger);
  });

  test('> 85% → red', () => {
    expect(pillColorFor(90)).toBe(PILL_COLORS.danger);
    expect(pillColorFor(100)).toBe(PILL_COLORS.danger);
    expect(pillColorFor(150)).toBe(PILL_COLORS.danger);
  });

  test('NaN / negative inputs fall through to green (safe default)', () => {
    expect(pillColorFor(Number.NaN)).toBe(PILL_COLORS.success);
    expect(pillColorFor(-1)).toBe(PILL_COLORS.success);
  });
});

describe('UsageFooter — escalates with the same ladder via contextPercent', () => {
  const { footerColorFor } = footerTest;

  test('undefined → no escalation (preserves legacy gray-dim styling)', () => {
    expect(footerColorFor(undefined)).toBe(undefined);
  });

  test('non-finite → no escalation', () => {
    expect(footerColorFor(Number.NaN)).toBe(undefined);
    expect(footerColorFor(Number.POSITIVE_INFINITY)).toBe(undefined);
  });

  test('< 60% → green', () => {
    expect(footerColorFor(0)).toBe(PILL_COLORS.success);
    expect(footerColorFor(59)).toBe(PILL_COLORS.success);
  });

  test('60..85% → yellow', () => {
    expect(footerColorFor(60)).toBe(PILL_COLORS.warning);
    expect(footerColorFor(84)).toBe(PILL_COLORS.warning);
  });

  test('>= 85% → red', () => {
    expect(footerColorFor(85)).toBe(PILL_COLORS.danger);
    expect(footerColorFor(99)).toBe(PILL_COLORS.danger);
  });
});
