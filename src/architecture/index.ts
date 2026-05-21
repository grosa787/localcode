/**
 * Architecture-rules barrel.
 *
 * Re-export the public API so call sites import from `@/architecture`
 * rather than reaching into specific files.
 */

export type {
  ArchConfig,
  ArchGlobal,
  ArchRule,
  ArchViolation,
  ImportEdge,
} from './types';

export {
  ArchConfigSchema,
  ArchGlobalSchema,
  ArchRuleSchema,
} from './types';

export {
  archConfigPath,
  ArchConfigError,
  loadArchConfig,
  parseArchConfigSource,
} from './loader';

export {
  _resetTsconfigCache,
  extractImports,
  extractImportsFromSource,
} from './import-extractor';

export {
  validateFile,
  validateProject,
  type ProjectValidationResult,
} from './validator';
