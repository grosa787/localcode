/**
 * Sub-agent template types.
 *
 * A template is a curated preset for spawning a specialist sub-agent: it
 * carries a short prompt, a recommended model placeholder, a read/write
 * approval hint, and a tools allow-list. The orchestrator consumes
 * templates via `spawnFromTemplate(id, task)` which fills in the system
 * prompt and tool whitelist from the template before calling the
 * underlying runner factory.
 */

/**
 * Approval profile hint. Mirrors the existing `permissions.profiles`
 * shape so a template can suggest a sensible default for the spawn.
 *
 * - `default` — the user's currently-active profile (no override).
 * - `readOnly` — block every mutating tool; useful for reviewers.
 * - `acceptEdits` — auto-approve write_file / edit_file commits but
 *   still prompt for run_command. Useful for documentation-writer style
 *   templates.
 */
export type AgentApprovalProfile = 'default' | 'readOnly' | 'acceptEdits';

/**
 * Curated catalog entry. Templates are stable identifiers — UI surfaces
 * and the `/spawn` slash command address them by `id`.
 */
export interface AgentTemplate {
  /** Stable kebab-case identifier (used in `/spawn <id> <task>`). */
  readonly id: string;
  /** Short human-readable name (≤ 24 chars). */
  readonly name: string;
  /** One-line tagline (≤ 80 chars). Rendered next to the name in pickers. */
  readonly tagline: string;
  /** Full description for tooltips / detail views. */
  readonly description: string;
  /**
   * System-prompt body injected into the worker. Short and specific —
   * the orchestrator concatenates this with the user-supplied task so
   * the worker knows what hat to wear.
   */
  readonly systemPrompt: string;
  /**
   * Recommended model id. Empty string means "inherit the worker model
   * configured in agents.workerModel / agents.workerSlots".
   */
  readonly recommendedModel: string;
  /**
   * Allow-list of tool names the worker may invoke. Empty array means
   * "no restriction" (defer to the worker's runtime tool map). When
   * non-empty, the orchestrator's runner-factory enforces this list.
   */
  readonly tools: readonly string[];
  /** Approval-profile hint. See `AgentApprovalProfile`. */
  readonly approvalProfile: AgentApprovalProfile;
}
