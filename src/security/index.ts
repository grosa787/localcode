/**
 * Public barrel for the security module. Import from here so internals
 * can evolve without per-file fan-out.
 */

export {
  shannonEntropy,
  looksHighEntropy,
} from './entropy';

export {
  scanText,
  scanCommitDiff,
  formatFinding,
  redact,
  type Finding,
  type Severity,
} from './secret-scanner';

export {
  loadAllowlist,
  applyAllowlist,
  isAllowed,
  allowlistPath,
  AllowlistEntrySchema,
  AllowlistFileSchema,
  type AllowlistEntry,
  type CompiledAllowlistEntry,
  type LoadedAllowlist,
} from './allowlist';

export {
  runSecretScannerBuiltin,
  defaultDiffSource,
  withBuiltinSecurityHooks,
  SECRET_SCANNER_BUILTIN,
  SECRET_SCANNER_HOOK,
  type BuiltinHookContext,
  type BuiltinHookResult,
  type BuiltinScannerHookEntry,
  type DiffSource,
} from './builtin-hook';
