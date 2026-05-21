/**
 * ProactiveDetector — heuristic pattern matcher that proposes
 * sub-agent templates based on recent user-message text and tool-call
 * traffic.
 *
 * Wave 6 — proactive suggestions panel.
 *
 * Pure observation. The detector NEVER spawns an agent — it only
 * returns suggestion descriptors, ranked by confidence. The UI panel
 * (`ProactiveSuggestionsPanel`) renders the top suggestion above the
 * InputBar and binds a hotkey for the user to accept.
 *
 * Rules:
 *   - "stack trace" / "error" / "fail" / "exception" → `debugger`
 *   - "слишком медленно" / "slow" / "performance" / `time<command>` → `performance-optimizer`
 *   - Many `read_file` calls without writes → `architect`
 *   - Many `edit_file` calls on test files → `test-engineer`
 *   - "security" / "secret" / "auth" / "creds" → `security-reviewer`
 *
 * Confidence rules align with the spec — only suggestions with
 * confidence ≥ 0.6 are returned. Tool-pattern detections have higher
 * weight than single keyword matches because they reflect actual
 * behaviour rather than chance words.
 */

// ---------- Types ----------

/** Single proactive suggestion. */
export interface ProactiveSuggestion {
  /** Stable per-suggestion id (templateId + short fingerprint). */
  readonly id: string;
  /**
   * Template id from the agent catalog (`debugger`, `architect`, ...).
   * Used by the UI panel to dispatch a spawn when the user accepts.
   */
  readonly templateId: string;
  /** Human reason shown next to the panel (`looks like you're debugging`). */
  readonly reason: string;
  /** [0, 1] — only ≥ 0.6 surfaces. */
  readonly confidence: number;
}

/** Snapshot of recent tool-call history. */
export interface ToolCallObservation {
  readonly toolName: string;
  /** Optional path (or first path-shaped arg) so we can detect test files. */
  readonly path?: string;
}

/** Input to the detector — assembled by the host from chat state. */
export interface DetectorInput {
  /** Last N user messages (newest last). N is host-defined; we trim ourselves. */
  readonly recentUserMessages: readonly string[];
  /** Tool calls in the current session, newest last. */
  readonly recentToolCalls: readonly ToolCallObservation[];
}

// ---------- Constants ----------

/** Confidence threshold gate — defined in the spec. */
export const PROACTIVE_CONFIDENCE_THRESHOLD = 0.6;

/** Window of most-recent items examined by each heuristic. */
const RECENT_USER_MSG_WINDOW = 5;
const RECENT_TOOL_CALL_WINDOW = 20;

// ---------- Pattern tables ----------

const DEBUGGER_PATTERNS: readonly { re: RegExp; weight: number }[] = [
  // Multi-word phrases are strong signals.
  { re: /\bstack\s+trace\b/i, weight: 0.65 },
  { re: /\btraceback\b/i, weight: 0.65 },
  { re: /\bexception\b/i, weight: 0.4 },
  { re: /\b(?:un)?caught\s+\w+error\b/i, weight: 0.55 },
  { re: /\b(?:typeerror|valueerror|referenceerror|attributeerror)\b/i, weight: 0.5 },
  // Single-word signals are weaker so they don't fire on incidental usage.
  { re: /\berror\b/i, weight: 0.25 },
  { re: /\bcrash(?:ed|ing)?\b/i, weight: 0.4 },
  { re: /\bbug\b/i, weight: 0.2 },
  { re: /\bfail(?:ing|ed|s)?\b/i, weight: 0.25 },
  { re: /\bbroken\b/i, weight: 0.25 },
];

const PERF_PATTERNS: readonly { re: RegExp; weight: number }[] = [
  { re: /\bperformance\b/i, weight: 0.5 },
  { re: /\bslow(?:er|ly|ness)?\b/i, weight: 0.35 },
  { re: /\bbottleneck\b/i, weight: 0.65 },
  { re: /\boptimi[sz]e\b/i, weight: 0.45 },
  // `time <command>` shell pattern.
  { re: /\btime\s+(?:bun|node|npm|yarn|pnpm|python|go|cargo|make)\b/i, weight: 0.6 },
  // Russian
  { re: /слишком\s+медленно/iu, weight: 0.65 },
  { re: /медленн/iu, weight: 0.4 },
  { re: /быстрее/iu, weight: 0.3 },
];

const SECURITY_PATTERNS: readonly { re: RegExp; weight: number }[] = [
  { re: /\bsecurity\b/i, weight: 0.45 },
  { re: /\bsecret(?:s)?\b/i, weight: 0.4 },
  { re: /\bauth(?:entication|orization)?\b/i, weight: 0.35 },
  { re: /\bcredential(?:s)?\b/i, weight: 0.45 },
  { re: /\bcreds\b/i, weight: 0.4 },
  { re: /\bcsrf\b/i, weight: 0.4 },
  { re: /\bxss\b/i, weight: 0.4 },
  { re: /\bsql\s+injection\b/i, weight: 0.6 },
  { re: /\bvulnerab/i, weight: 0.5 },
  { re: /\bsanitis[ez]/i, weight: 0.3 },
];

// ---------- Helpers ----------

/** Strip code regions so a snippet doesn't trigger spurious keywords. */
function stripCode(message: string): string {
  return message
    .replace(/```[^\n]*\n[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ');
}

function sumPatternWeights(
  text: string,
  patterns: readonly { re: RegExp; weight: number }[],
): number {
  let total = 0;
  for (const p of patterns) {
    if (p.re.test(text)) {
      total += p.weight;
    }
  }
  return total;
}

function isTestPath(p: string | undefined): boolean {
  if (p === undefined || p.length === 0) return false;
  const lower = p.toLowerCase();
  // Common test layouts: `tests/foo.ts`, `__tests__/`, `*.test.*`, `*.spec.*`.
  return (
    /(^|\/)tests?\//.test(lower) ||
    /(^|\/)__tests__\//.test(lower) ||
    /\.(?:test|spec)\.[a-z0-9]+$/.test(lower)
  );
}

function fingerprint(reason: string): string {
  let hash = 2166136261;
  for (let i = 0; i < reason.length; i += 1) {
    hash ^= reason.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(16);
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ---------- Detector ----------

export interface ProactiveDetectorOptions {
  /** Override the default confidence gate. Used by tests. */
  readonly minConfidence?: number;
}

export class ProactiveDetector {
  private readonly minConfidence: number;

  constructor(opts: ProactiveDetectorOptions = {}) {
    this.minConfidence = opts.minConfidence ?? PROACTIVE_CONFIDENCE_THRESHOLD;
  }

  /**
   * Inspect recent activity and return all qualifying suggestions
   * sorted by descending confidence. The host may render only the
   * top entry — returning the full list keeps the API friendly for
   * tests and future UI changes.
   */
  detect(input: DetectorInput): readonly ProactiveSuggestion[] {
    const out: ProactiveSuggestion[] = [];
    const userText = input.recentUserMessages
      .slice(-RECENT_USER_MSG_WINDOW)
      .map(stripCode)
      .join('\n');
    const recentToolCalls = input.recentToolCalls.slice(-RECENT_TOOL_CALL_WINDOW);

    const debuggerConf = this.detectDebugger(userText, recentToolCalls);
    if (debuggerConf !== null) out.push(debuggerConf);

    const perfConf = this.detectPerf(userText, recentToolCalls);
    if (perfConf !== null) out.push(perfConf);

    const architectConf = this.detectArchitect(recentToolCalls);
    if (architectConf !== null) out.push(architectConf);

    const testEngConf = this.detectTestEngineer(recentToolCalls);
    if (testEngConf !== null) out.push(testEngConf);

    const securityConf = this.detectSecurity(userText);
    if (securityConf !== null) out.push(securityConf);

    out.sort((a, b) => b.confidence - a.confidence);
    return out;
  }

  /** Convenience — top suggestion only, or null when nothing qualifies. */
  top(input: DetectorInput): ProactiveSuggestion | null {
    const all = this.detect(input);
    return all[0] ?? null;
  }

  private build(
    templateId: string,
    reason: string,
    rawConfidence: number,
  ): ProactiveSuggestion | null {
    const confidence = clamp01(rawConfidence);
    if (confidence < this.minConfidence) return null;
    return {
      id: `${templateId}-${fingerprint(reason)}`,
      templateId,
      reason,
      confidence,
    };
  }

  private detectDebugger(
    userText: string,
    toolCalls: readonly ToolCallObservation[],
  ): ProactiveSuggestion | null {
    const textScore = sumPatternWeights(userText, DEBUGGER_PATTERNS);
    // Boost: if the user just ran a failing command (`run_command`), the
    // case for the debugger goes up. We can't see exit codes here so we
    // proxy via the keyword match — tool-call presence alone is not
    // enough.
    const ranCommand = toolCalls.some((c) => c.toolName === 'run_command');
    const boost = ranCommand && textScore > 0 ? 0.15 : 0;
    return this.build(
      'debugger',
      'Looks like you are debugging — spawn debugger agent?',
      textScore + boost,
    );
  }

  private detectPerf(
    userText: string,
    toolCalls: readonly ToolCallObservation[],
  ): ProactiveSuggestion | null {
    const textScore = sumPatternWeights(userText, PERF_PATTERNS);
    // `time <command>` in a recent run_command invocation is a strong
    // signal even without the keyword hitting.
    let toolBoost = 0;
    for (const c of toolCalls) {
      if (c.toolName === 'run_command' && c.path !== undefined && /\btime\b/.test(c.path)) {
        toolBoost = Math.max(toolBoost, 0.3);
      }
    }
    return this.build(
      'performance-optimizer',
      'Sounds like a perf concern — spawn performance-optimizer agent?',
      textScore + toolBoost,
    );
  }

  private detectArchitect(
    toolCalls: readonly ToolCallObservation[],
  ): ProactiveSuggestion | null {
    if (toolCalls.length === 0) return null;
    let reads = 0;
    let writes = 0;
    for (const c of toolCalls) {
      if (c.toolName === 'read_file' || c.toolName === 'list_dir' || c.toolName === 'glob_search') {
        reads += 1;
      } else if (
        c.toolName === 'write_file' ||
        c.toolName === 'edit_file' ||
        c.toolName === 'run_command'
      ) {
        writes += 1;
      }
    }
    // Need a meaningful exploration burst: ≥ 6 reads and at most 1 write.
    if (reads < 6 || writes > 1) return null;
    // Map (reads, writes) → confidence with a soft ceiling.
    const ratio = reads / Math.max(1, reads + writes);
    const conf = clamp01(0.55 + Math.min(0.2, (reads - 6) * 0.03) + (ratio - 0.8) * 0.5);
    return this.build(
      'architect',
      'Lots of reading without writing — spawn architect for an overview?',
      conf,
    );
  }

  private detectTestEngineer(
    toolCalls: readonly ToolCallObservation[],
  ): ProactiveSuggestion | null {
    if (toolCalls.length === 0) return null;
    let testEdits = 0;
    let totalEdits = 0;
    for (const c of toolCalls) {
      if (c.toolName === 'edit_file' || c.toolName === 'write_file') {
        totalEdits += 1;
        if (isTestPath(c.path)) testEdits += 1;
      }
    }
    if (testEdits < 3) return null;
    // Confidence increases with both raw count and test-density.
    const density = testEdits / Math.max(1, totalEdits);
    const conf = clamp01(0.5 + (testEdits - 3) * 0.05 + (density - 0.5) * 0.3);
    return this.build(
      'test-engineer',
      'Many edits in test files — spawn test-engineer to expand coverage?',
      conf,
    );
  }

  private detectSecurity(userText: string): ProactiveSuggestion | null {
    const textScore = sumPatternWeights(userText, SECURITY_PATTERNS);
    return this.build(
      'security-reviewer',
      'Touches security-sensitive code — spawn security-reviewer agent?',
      textScore,
    );
  }
}

// ---------- Exports for tests ----------

/** Exposed for testability — same predicate the detector uses internally. */
export const __test__ = {
  isTestPath,
  stripCode,
  sumPatternWeights,
  DEBUGGER_PATTERNS,
  PERF_PATTERNS,
  SECURITY_PATTERNS,
};
