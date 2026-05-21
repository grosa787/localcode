/**
 * Public surface of the recordings module.
 *
 * Composition roots (TUI / web / tests) consume types and helpers from
 * this barrel rather than reaching into per-file modules.
 */

export type {
  Recording,
  RecordingAssistantEntry,
  RecordingEntry,
  RecordingSystemEntry,
  RecordingToolCallEntry,
  RecordingUserEntry,
  ReplayDispatch,
  ReplayOptions,
} from './types';

export {
  Recorder,
  RecorderError,
  defaultRecordingPath,
  saveRecording,
  serializeRecording,
} from './recorder';
export type { RecorderOptions } from './recorder';

export { Player, PlayerError, loadRecording, parseRecording } from './player';
export type { PlayerOptions } from './player';
