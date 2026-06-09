/**
 * Deterministic ink-frame settle helper for CI render tests.
 *
 * ink renders to the fake stdout asynchronously. A fixed `setTimeout(200)`
 * race-loses on slow / headless CI runners — the read catches only the
 * cursor-hide escape (`[?25l`) before the real frame lands, so the
 * layout assertions flake. Instead of guessing a wait, poll `read()` until
 * the frame is MEANINGFUL (more than control escapes) AND unchanged for
 * `quietMs` (the render has settled), bounded by `timeoutMs`.
 *
 * Returns fast on a quick local machine, tolerant on a slow CI runner, and
 * is content-agnostic so both positive (`toContain`) and negative
 * (`not.toContain`) assertions work against the returned frame.
 */
export async function settleFrame(
  read: () => string,
  opts: { timeoutMs?: number; quietMs?: number; intervalMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const quietMs = opts.quietMs ?? 60;
  const intervalMs = opts.intervalMs ?? 15;
  // Strip ANSI/control escapes (incl. the cursor-hide `[?25l`) so a frame
  // that is "only escapes" is not mistaken for rendered content.
  const meaningful = (s: string): boolean =>
    s.replace(/\[[0-9;?]*[A-Za-z]/g, '').trim().length > 0;

  const start = Date.now();
  let last = '';
  let stableSince = 0;
  while (Date.now() - start < timeoutMs) {
    const cur = read();
    if (meaningful(cur) && cur === last) {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince >= quietMs) return cur;
    } else {
      last = cur;
      stableSince = 0;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}
