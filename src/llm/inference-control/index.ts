/**
 * Wave 16B — inference-control public surface.
 *
 * The local-first constrained-decoding moat. See the individual modules
 * for detail; the adapter consumes this barrel from its
 * `// INFERENCE-CONTROL-SECTION` block.
 */

export type { CapabilityReport, GrammarSpec } from './types';
export {
  CLOUD_BACKENDS,
  LOCAL_BACKENDS,
  disabledReport,
  isLocalInferenceBackend,
} from './types';
export {
  DEFAULT_CAPABILITY_TTL_MS,
  probeCapabilities,
  type FetchImpl,
  type ProbeCapabilitiesParams,
} from './capability-probe';
export { compileToolGrammar } from './grammar';
export {
  BAN_BIAS,
  BOOST_BIAS,
  MAX_BOOST_SYMBOLS,
  buildSymbolLogitBias,
  type BuildSymbolLogitBiasParams,
  type LogitBiasMode,
  type SymbolLogitBiasResult,
} from './logit-bias';
