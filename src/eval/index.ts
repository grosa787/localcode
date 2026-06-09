/**
 * Golden-task eval harness — public barrel.
 *
 * Wave 16A keystone instrument: run real multi-step agent tasks against a
 * live adapter + ToolExecutor and measure TASK SUCCESS (pass-rate, tokens,
 * cost, latency) across model+config combos.
 */

export type {
  GoldenTask,
  TaskResult,
  EvalReport,
  SuccessCheck,
} from './types';

export { GOLDEN_TASKS, findTaskById, listTaskIds } from './tasks';

export {
  runTask,
  runSuite,
  aggregate,
  EVAL_DONE_SENTINEL,
} from './runner';
export type {
  EvalAdapter,
  RunTaskOptions,
  RunSuiteOptions,
} from './runner';

export { formatReport, toJson } from './report';
