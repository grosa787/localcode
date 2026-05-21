/**
 * `parseCronSpec` + `nextFireTime` coverage.
 *
 * Covers the supported subset (`*`, exact, list, range, step) and the
 * common scheduling patterns the task brief calls out:
 *   - `* * * * *`       — every minute,
 *   - `0 9 * * *`       — 9am daily,
 *   - `* /5 * * * *`     — every 5 minutes,
 *   - day-of-month / day-of-week interaction.
 */

import { describe, test, expect } from 'bun:test';
import {
  CronSpecParseError,
  nextFireTime,
  parseCronSpec,
} from '@/scheduling';

describe('parseCronSpec — supported syntax', () => {
  test('wildcard `*` populates the full range for each field', () => {
    const spec = parseCronSpec('* * * * *');
    expect(spec.minutes.length).toBe(60);
    expect(spec.hours.length).toBe(24);
    expect(spec.daysOfMonth.length).toBe(31);
    expect(spec.months.length).toBe(12);
    expect(spec.daysOfWeek.length).toBe(7);
    expect(spec.domWildcard).toBe(true);
    expect(spec.dowWildcard).toBe(true);
  });

  test('exact values produce singleton sets', () => {
    const spec = parseCronSpec('5 9 1 1 0');
    expect(spec.minutes).toEqual([5]);
    expect(spec.hours).toEqual([9]);
    expect(spec.daysOfMonth).toEqual([1]);
    expect(spec.months).toEqual([1]);
    expect(spec.daysOfWeek).toEqual([0]);
  });

  test('list `,` collects multiple exact values', () => {
    const spec = parseCronSpec('0,15,30,45 * * * *');
    expect(spec.minutes).toEqual([0, 15, 30, 45]);
  });

  test('range `A-B` is inclusive', () => {
    const spec = parseCronSpec('* 9-17 * * *');
    expect(spec.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  test('step `*/N` walks the field by N', () => {
    const spec = parseCronSpec('*/5 * * * *');
    expect(spec.minutes).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  test('stepped range `A-B/N` walks within bounds', () => {
    const spec = parseCronSpec('0-30/10 * * * *');
    expect(spec.minutes).toEqual([0, 10, 20, 30]);
  });
});

describe('parseCronSpec — error cases', () => {
  test('wrong field count throws', () => {
    expect(() => parseCronSpec('* * * *')).toThrow(CronSpecParseError);
    expect(() => parseCronSpec('* * * * * *')).toThrow(CronSpecParseError);
  });

  test('out-of-range values throw', () => {
    expect(() => parseCronSpec('60 * * * *')).toThrow(CronSpecParseError);
    expect(() => parseCronSpec('* 24 * * *')).toThrow(CronSpecParseError);
    expect(() => parseCronSpec('* * 32 * *')).toThrow(CronSpecParseError);
    expect(() => parseCronSpec('* * * 13 *')).toThrow(CronSpecParseError);
    expect(() => parseCronSpec('* * * * 7')).toThrow(CronSpecParseError);
  });

  test('inverted range throws', () => {
    expect(() => parseCronSpec('30-10 * * * *')).toThrow(CronSpecParseError);
  });

  test('invalid step throws', () => {
    expect(() => parseCronSpec('*/0 * * * *')).toThrow(CronSpecParseError);
  });

  test('non-numeric value throws', () => {
    expect(() => parseCronSpec('MON * * * *')).toThrow(CronSpecParseError);
  });
});

describe('nextFireTime — common patterns', () => {
  test('every minute: next fire is the next minute boundary', () => {
    const spec = parseCronSpec('* * * * *');
    // Use a fixed reference at 12:34:56.789 local time.
    const ref = new Date(2026, 4, 18, 12, 34, 56, 789).getTime();
    const next = nextFireTime(spec, ref);
    const nextDate = new Date(next);
    expect(nextDate.getSeconds()).toBe(0);
    expect(nextDate.getMinutes()).toBe(35);
    expect(nextDate.getHours()).toBe(12);
  });

  test('0 9 * * * fires at the next 9am local', () => {
    const spec = parseCronSpec('0 9 * * *');
    // Ref at 10am — should advance to tomorrow 9am.
    const ref = new Date(2026, 4, 18, 10, 0, 0, 0).getTime();
    const next = nextFireTime(spec, ref);
    const nd = new Date(next);
    expect(nd.getHours()).toBe(9);
    expect(nd.getMinutes()).toBe(0);
    // Day must be 19 (next day after 18).
    expect(nd.getDate()).toBe(19);
  });

  test('0 9 * * * fires today at 9am when ref is before', () => {
    const spec = parseCronSpec('0 9 * * *');
    const ref = new Date(2026, 4, 18, 8, 30, 0, 0).getTime();
    const next = nextFireTime(spec, ref);
    const nd = new Date(next);
    expect(nd.getDate()).toBe(18);
    expect(nd.getHours()).toBe(9);
    expect(nd.getMinutes()).toBe(0);
  });

  test('*/5 * * * * fires at the next 5-minute boundary', () => {
    const spec = parseCronSpec('*/5 * * * *');
    const ref = new Date(2026, 4, 18, 10, 23, 0, 0).getTime();
    const next = nextFireTime(spec, ref);
    const nd = new Date(next);
    expect(nd.getMinutes()).toBe(25);
  });

  test('*/5 wraps the hour boundary', () => {
    const spec = parseCronSpec('*/5 * * * *');
    const ref = new Date(2026, 4, 18, 10, 58, 0, 0).getTime();
    const next = nextFireTime(spec, ref);
    const nd = new Date(next);
    expect(nd.getHours()).toBe(11);
    expect(nd.getMinutes()).toBe(0);
  });

  test('impossible spec throws (Feb 30)', () => {
    const spec = parseCronSpec('0 0 30 2 *');
    const ref = new Date(2026, 0, 1).getTime();
    expect(() => nextFireTime(spec, ref)).toThrow(CronSpecParseError);
  });

  test('dom + dow restricted: matches when EITHER hits', () => {
    // Run on the 1st of the month OR on a Sunday.
    const spec = parseCronSpec('0 0 1 * 0');
    // Choose a date that is neither — should advance to one that is.
    // 2026-05-18 is a Monday, dom=18 — neither matches.
    const ref = new Date(2026, 4, 18, 12, 0, 0, 0).getTime();
    const next = nextFireTime(spec, ref);
    const nd = new Date(next);
    // 2026-05-24 is a Sunday (dow=0) → that is the next match before
    // the next 1st (2026-06-01). Just check we got one of those.
    const isSunday = nd.getDay() === 0;
    const isFirst = nd.getDate() === 1;
    expect(isSunday || isFirst).toBe(true);
    expect(nd.getHours()).toBe(0);
    expect(nd.getMinutes()).toBe(0);
  });
});
