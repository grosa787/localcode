/**
 * Minimal 5-field cron parser. Hand-rolled because `cron-parser` is not
 * a dependency and we only need the common subset.
 *
 * Format: `<minute> <hour> <day-of-month> <month> <day-of-week>`
 *
 * Supported per-field syntax:
 *   - `*`       → every value in the field range
 *   - `N`       → exact value (e.g. `5`)
 *   - `N,M,…`   → list of values
 *   - `A-B`     → inclusive range
 *   - `* /N`     → step (every N starting from the field's lower bound)
 *   - `A-B/N`   → stepped range
 *
 * Not supported (documented gap):
 *   - `L` (last day of month)
 *   - `W` (nearest weekday)
 *   - `#` (nth weekday)
 *   - Named values (`JAN`, `MON`)
 *   - 6-field / 7-field cron (seconds / years)
 *
 * Field ranges (inclusive):
 *   - minute: 0..59
 *   - hour:   0..23
 *   - dom:    1..31
 *   - month:  1..12
 *   - dow:    0..6  (0 = Sunday)
 *
 * Day-of-month + day-of-week interaction: when BOTH are restricted (not
 * `*`), the spec fires if EITHER matches — matching POSIX cron
 * semantics. When only one is restricted, the other is treated as `*`.
 */

export interface ParsedCronSpec {
  readonly raw: string;
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[];
  readonly months: readonly number[];
  readonly daysOfWeek: readonly number[];
  /** True iff `daysOfMonth` was `*` in the source. */
  readonly domWildcard: boolean;
  /** True iff `daysOfWeek` was `*` in the source. */
  readonly dowWildcard: boolean;
}

export class CronSpecParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronSpecParseError';
  }
}

interface FieldDef {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

const FIELDS: readonly FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
];

/**
 * Parse a 5-field cron expression. Throws `CronSpecParseError` on
 * malformed input.
 */
export function parseCronSpec(input: string): ParsedCronSpec {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new CronSpecParseError('Cron spec is empty');
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new CronSpecParseError(
      `Cron spec must have exactly 5 fields; got ${fields.length} in "${input}"`,
    );
  }
  const fieldZero = fields[0];
  const fieldOne = fields[1];
  const fieldTwo = fields[2];
  const fieldThree = fields[3];
  const fieldFour = fields[4];
  if (
    fieldZero === undefined ||
    fieldOne === undefined ||
    fieldTwo === undefined ||
    fieldThree === undefined ||
    fieldFour === undefined
  ) {
    throw new CronSpecParseError(`Cron spec is malformed: "${input}"`);
  }
  const minuteDef = FIELDS[0];
  const hourDef = FIELDS[1];
  const domDef = FIELDS[2];
  const monthDef = FIELDS[3];
  const dowDef = FIELDS[4];
  if (
    minuteDef === undefined ||
    hourDef === undefined ||
    domDef === undefined ||
    monthDef === undefined ||
    dowDef === undefined
  ) {
    throw new CronSpecParseError('Internal field definitions missing');
  }
  return {
    raw: trimmed,
    minutes: parseField(fieldZero, minuteDef),
    hours: parseField(fieldOne, hourDef),
    daysOfMonth: parseField(fieldTwo, domDef),
    months: parseField(fieldThree, monthDef),
    daysOfWeek: parseField(fieldFour, dowDef),
    domWildcard: fieldTwo === '*',
    dowWildcard: fieldFour === '*',
  };
}

function parseField(token: string, def: FieldDef): number[] {
  const values = new Set<number>();
  for (const part of token.split(',')) {
    parsePart(part, def, values);
  }
  return [...values].sort((a, b) => a - b);
}

function parsePart(part: string, def: FieldDef, out: Set<number>): void {
  let rangePart = part;
  let step = 1;
  const slashIdx = part.indexOf('/');
  if (slashIdx >= 0) {
    rangePart = part.slice(0, slashIdx);
    const stepStr = part.slice(slashIdx + 1);
    const parsedStep = Number.parseInt(stepStr, 10);
    if (!Number.isInteger(parsedStep) || parsedStep <= 0) {
      throw new CronSpecParseError(
        `Invalid step '${stepStr}' in ${def.name} field`,
      );
    }
    step = parsedStep;
  }
  let lo: number;
  let hi: number;
  if (rangePart === '*' || rangePart === '') {
    lo = def.min;
    hi = def.max;
  } else if (rangePart.includes('-')) {
    const dashIdx = rangePart.indexOf('-');
    const loStr = rangePart.slice(0, dashIdx);
    const hiStr = rangePart.slice(dashIdx + 1);
    lo = parseExact(loStr, def);
    hi = parseExact(hiStr, def);
    if (lo > hi) {
      throw new CronSpecParseError(
        `Range ${lo}-${hi} is inverted in ${def.name} field`,
      );
    }
  } else {
    const exact = parseExact(rangePart, def);
    lo = exact;
    hi = exact;
  }
  for (let v = lo; v <= hi; v += step) {
    if (v < def.min || v > def.max) continue;
    out.add(v);
  }
}

function parseExact(token: string, def: FieldDef): number {
  const n = Number.parseInt(token, 10);
  if (!Number.isInteger(n)) {
    throw new CronSpecParseError(
      `Expected integer in ${def.name} field; got '${token}'`,
    );
  }
  if (n < def.min || n > def.max) {
    throw new CronSpecParseError(
      `Value ${n} out of range [${def.min}, ${def.max}] for ${def.name} field`,
    );
  }
  return n;
}

/**
 * Compute the next fire time (ms since epoch) at or after `fromMs`.
 *
 * Algorithm: linear scan minute-by-minute starting at the next minute
 * after `fromMs`. Bounds the scan to 4 years to keep pathologically
 * impossible specs (e.g. `0 0 31 2 *` — Feb 31st never exists) from
 * looping forever — throws `CronSpecParseError` if no match is found.
 *
 * Working in local time matches POSIX cron and what users expect from
 * `0 9 * * *` ("9 am local"); UTC could be added later via a flag.
 */
export function nextFireTime(
  spec: ParsedCronSpec,
  fromMs: number,
): number {
  // Move to the next minute boundary strictly after fromMs.
  const start = new Date(fromMs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  // 4 years × 366 days × 1440 min — wide envelope that catches any
  // realistic schedule including leap-year edge cases.
  const MAX_ITERATIONS = 4 * 366 * 24 * 60;
  const current = new Date(start.getTime());
  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    if (matchesAt(spec, current)) return current.getTime();
    current.setMinutes(current.getMinutes() + 1);
  }
  throw new CronSpecParseError(
    `Cron spec "${spec.raw}" has no fire time within 4 years of ${new Date(fromMs).toISOString()}`,
  );
}

function matchesAt(spec: ParsedCronSpec, when: Date): boolean {
  if (!spec.minutes.includes(when.getMinutes())) return false;
  if (!spec.hours.includes(when.getHours())) return false;
  if (!spec.months.includes(when.getMonth() + 1)) return false;
  const dom = when.getDate();
  const dow = when.getDay();
  const domMatch = spec.daysOfMonth.includes(dom);
  const dowMatch = spec.daysOfWeek.includes(dow);
  // POSIX semantics: if BOTH dom and dow are restricted, OR them; if
  // either is `*`, only the restricted one matters.
  if (spec.domWildcard && spec.dowWildcard) return true;
  if (spec.domWildcard) return dowMatch;
  if (spec.dowWildcard) return domMatch;
  return domMatch || dowMatch;
}

/** Friendly summary string for `/cron list`. */
export function describeCronSpec(spec: ParsedCronSpec): string {
  return spec.raw;
}
