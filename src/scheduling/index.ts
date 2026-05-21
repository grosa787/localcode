/**
 * Public surface of the in-session scheduler module. The TUI / web
 * composition roots and the `schedule_wakeup` tool consume types and
 * functions from this barrel rather than reaching into the per-file
 * modules.
 */

export type {
  ScheduledWakeup,
  WakeupCallback,
  WakeupListChangeListener,
  WakeupRegistryOptions,
} from './types';

export {
  WakeupRegistry,
  WAKEUP_MIN_DELAY_MS,
  WAKEUP_MAX_DELAY_MS,
  getProcessWakeupRegistry,
  setProcessWakeupRegistry,
} from './wakeup-registry';

// Cross-session persistent crons.
export type {
  PersistentCronEntry,
  PersistentCronFile,
} from './persistent-store';
export {
  PersistentStoreError,
  defaultCronStorePath,
  loadCronStore,
  newCronId,
  saveCronStore,
  updateCronStore,
} from './persistent-store';

export type {
  ParsedCronSpec,
} from './cron-spec-parser';
export {
  CronSpecParseError,
  describeCronSpec,
  nextFireTime,
  parseCronSpec,
} from './cron-spec-parser';

export type {
  PersistentCronDispatch,
  PersistentCronDispatchContext,
  PersistentSchedulerOptions,
} from './persistent-scheduler';
export { PersistentScheduler } from './persistent-scheduler';
