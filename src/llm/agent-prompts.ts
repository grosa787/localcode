/**
 * System-prompt builders for multi-agent runs.
 *
 * `buildLeadAgentPrompt`   — section appended to the lead's system prompt
 *                            when agent-* tools are exposed.
 * `buildWorkerAgentPrompt` — full system prompt for a sub-agent. Replaces
 *                            the lead persona; tells the worker who it is,
 *                            what it owns, who else is on the team, and
 *                            the communication / output protocol.
 *
 * Both are pure string builders — no I/O, deterministic for a given
 * input — so they can be reused by tests and other harnesses.
 */

/**
 * Single configured worker slot, surfaced in the lead's system prompt so
 * the model knows the exact strict allow-list of models it may pass to
 * `spawn_agent`. Mirrors `AgentsWorkerSlotConfig` from `@/types/global`
 * but kept minimal here to avoid a circular import.
 */
export interface LeadPromptWorkerSlot {
  model: string;
  skills?: readonly string[];
}

export interface BuildLeadAgentPromptOptions {
  /** Tool names the lead has access to (used only for documentation). */
  availableTools: readonly string[];
  /**
   * Strict allow-list of worker slots the lead may spawn. When supplied
   * and non-empty, the prompt lists each slot explicitly and reminds
   * the model that ONLY these models / slot indices are accepted by
   * `spawn_agent`. When empty / undefined, no slot section is added —
   * preserves byte-stable backward-compat output for tests + caches.
   */
  workerSlots?: readonly LeadPromptWorkerSlot[];
  /**
   * Legacy single-model fallback model id, surfaced when no slots are
   * configured. Optional; rendered only when present and `workerSlots`
   * is empty / absent.
   */
  workerModelFallback?: string;
}

export function buildLeadAgentPrompt(opts: BuildLeadAgentPromptOptions): string {
  const tools = opts.availableTools.length > 0
    ? `\nAgent tools: ${opts.availableTools.join(', ')}.`
    : '';
  const lines: string[] = [
    '## Multi-agent orchestration',
    'Team lead. When a task is broad enough to parallelise:',
    '1. ANALYSE — identify INDEPENDENT files (no overlap).',
    '2. ALLOCATE files exclusively per agent — same file never to two agents.',
    '3. SPAWN 2-5 sub-agents via spawn_agent with: owned files (exclusive write), task slice, read-list (files owned by others).',
    "4. BROADCAST via team_send({to:'all'}) the plan + each agent's responsibility so workers can coordinate.",
    "5. POLL agent_status OR await_agent serially. Issue all spawn calls first, THEN await — don't await all in parallel.",
    '6. After done: REVIEW diffs, MERGE conflicts, write summary.',
    '',
    'Skip spawning for 1-file edits or when serialisation beats ~10s spawn overhead.' + tools,
  ];

  // Strict slot allow-list — the model must pick from this list when
  // calling spawn_agent. Render deterministically (input order) so the
  // prompt prefix stays byte-stable across turns.
  if (opts.workerSlots !== undefined && opts.workerSlots.length > 0) {
    lines.push('', '## Available worker slots');
    opts.workerSlots.forEach((slot, idx) => {
      const skillsStr =
        slot.skills !== undefined && slot.skills.length > 0
          ? ` (skills: [${slot.skills.join(', ')}])`
          : '';
      lines.push(`Slot ${idx}: ${slot.model}${skillsStr}`);
    });
    lines.push(
      '',
      'When calling spawn_agent, use ONLY these models. ' +
        'Pass `slot: <i>` (preferred) or `model: "<exact model id>"`. ' +
        'Any other model id will be REJECTED.',
    );
  } else if (
    opts.workerModelFallback !== undefined &&
    opts.workerModelFallback.length > 0
  ) {
    // Legacy single-model fallback. Only emitted when no slots are
    // configured — keeps the cache-stable invariant for sessions that
    // have never touched the slot UI.
    lines.push(
      '',
      '## Available worker model',
      `Default: ${opts.workerModelFallback}`,
      '',
      'No worker slots configured — spawn_agent uses this default. ' +
        'Configure slots via UserCog -> Worker slots in the web UI to enable strict allow-list enforcement.',
    );
  }

  return lines.join('\n');
}

export interface BuildWorkerAgentPromptOptions {
  agentId: string;
  task: string;
  ownedFiles: readonly string[];
  otherAgents: ReadonlyArray<{ id: string; ownedFiles: readonly string[] }>;
  /**
   * Optional skill-id list inherited from either the lead's
   * `spawn_agent({ skills: [...] })` arg OR the matched worker-slot's
   * `skills` field. Surfaced in the worker's system prompt so the model
   * leans on the configured tool subset. Empty / absent means "no
   * skill bias".
   */
  skills?: readonly string[];
  /**
   * Optional active backend type. When `'lmstudio'`, the worker prompt
   * appends a one-line note reminding the model that LM Studio shares
   * inference slots between parallel agents — encourages concise
   * reasoning to keep all workers responsive.
   */
  runtimeBackend?:
    | 'lmstudio'
    | 'ollama'
    | 'openai'
    | 'anthropic'
    | 'openrouter'
    | 'google'
    | 'custom';
}

export function buildWorkerAgentPrompt(opts: BuildWorkerAgentPromptOptions): string {
  const ownedList =
    opts.ownedFiles.length > 0
      ? opts.ownedFiles.map((f) => `- ${f}`).join('\n')
      : '(none — coordinate via team_send before writing any file)';
  const otherList =
    opts.otherAgents.length > 0
      ? opts.otherAgents
          .map((a) =>
            `- ${a.id} → ${a.ownedFiles.length > 0 ? a.ownedFiles.join(', ') : '(unknown)'}`,
          )
          .join('\n')
      : '(none — you are the only sub-agent on this team)';

  const lmstudioHint =
    opts.runtimeBackend === 'lmstudio'
      ? '\n\n(You are running on LM Studio — your inference shares slots with other parallel agents. Prefer concise reasoning.)'
      : '';

  const sections: string[] = [
    `Sub-agent ${opts.agentId}. Task: ${opts.task}`,
    '',
    '## Files you own (exclusive write):',
    ownedList,
    '',
    '## Other agents (READ-ONLY for you):',
    otherList,
  ];

  // Skill bias — surfaced when the lead / slot config supplied a
  // non-empty list. Pure function of inputs (no sorting / mutation) so
  // tests that compare prompts byte-for-byte stay deterministic.
  if (opts.skills !== undefined && opts.skills.length > 0) {
    sections.push(
      '',
      '## Skills bias',
      `Lean on these skills when relevant: ${opts.skills.join(', ')}.`,
    );
  }

  sections.push(
    '',
    '## Communication',
    "team_send({to:'all'|<agentId>}) to coordinate; team_read() to receive. Send a 1-line plan to 'all' before starting. If you need another agent's file, ASK via team_send — don't edit.",
    '',
    '## Output protocol',
    'End your final message with "<DONE>" then a 5-line summary of changes + coordination notes.',
    '',
    "Don't ask clarifying questions — task is fixed. Make the best call and document it.",
  );

  return sections.join('\n') + lmstudioHint;
}

/** Sentinel string the worker uses to mark task completion. */
export const WORKER_DONE_SENTINEL = '<DONE>';

/**
 * Extract the post-`<DONE>` summary from a worker's final assistant text.
 * Returns the trimmed text after the sentinel, or the entire trimmed
 * input when the sentinel is absent.
 */
export function extractWorkerSummary(finalText: string): string {
  const idx = finalText.indexOf(WORKER_DONE_SENTINEL);
  if (idx < 0) return finalText.trim();
  return finalText.slice(idx + WORKER_DONE_SENTINEL.length).trim();
}
