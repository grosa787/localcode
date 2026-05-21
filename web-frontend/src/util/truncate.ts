/** Truncate a string to `max` chars, replacing the tail with `…`. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
