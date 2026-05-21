/**
 * Process-monitor barrel.
 *
 * Re-exports the public surface of `src/process-monitor/`:
 *   - the `ProcessMonitor` class + singleton accessor
 *   - the wire types (`WatchedProcess`, `ProcessEvent`, `DiagnosticSignal`,
 *     `CompileErrorDigest`, …)
 *   - the diagnoser helper (`diagnose`) so tests and the `/diagnose`
 *     slash command can run categorisation against a custom line set.
 */

export {
  DIAGNOSTIC_THROTTLE_MS,
  KILL_GRACE_MS,
  MAX_WATCHED,
  ProcessMonitor,
  RECENT_LINES_KEPT,
  RING_BUFFER_CAP_BYTES,
  getProcessMonitor,
  setProcessMonitor,
} from './registry';
export type { WatchOptions } from './registry';

export { diagnose } from './diagnoser';

export type {
  CompileErrorDigest,
  DiagnosticSeverity,
  DiagnosticSignal,
  DiagnosticSource,
  ProcessEvent,
  ProcessHealth,
  WatchedProcess,
} from './types';
