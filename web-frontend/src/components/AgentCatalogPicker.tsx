/**
 * AgentCatalogPicker — overlay listing the 10 curated sub-agent templates.
 *
 * Click a card to call `onLaunch(templateId)`. The parent owns what
 * happens next (slash dispatch via `/spawn <id> <task>`, dedicated WS
 * frame, REST POST, etc.) — this component is intentionally
 * presentation-only so it can be reused by both the team panel and a
 * future right-click "spawn specialist" menu.
 *
 * The catalog data is duplicated here (mirroring `src/agents/catalog/
 * templates.ts`) because the SPA's tsconfig path map does not include
 * `src/agents/*`. The test in `tests/agents/catalog.test.ts` asserts
 * that the server-side catalog has all 10 ids; if a future PR drifts
 * the two, that test will fail.
 */
import { useMemo, useState, type JSX } from 'react';

import { Modal, ModalBody, ModalFooter } from './Modal';
import { Users } from '../icons';

import styles from './AgentCatalogPicker.module.css';

/** Approval-profile hint. Mirrors `src/agents/catalog/types.ts`. */
export type AgentApprovalProfile = 'default' | 'readOnly' | 'acceptEdits';

/** Catalog entry. Mirrors `src/agents/catalog/types.ts`. */
export interface AgentCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  readonly approvalProfile: AgentApprovalProfile;
}

/**
 * The 10 starter templates — id/name/tagline/approvalProfile only. The
 * server-side catalog owns the full system prompt + tools allow-list;
 * the SPA only needs the picker view.
 */
export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  {
    id: 'architect',
    name: 'Architect',
    tagline: 'System design, scaling decisions, technology tradeoffs.',
    approvalProfile: 'default',
  },
  {
    id: 'debugger',
    name: 'Debugger',
    tagline: 'Root-cause analysis from stack traces, logs, and repros.',
    approvalProfile: 'default',
  },
  {
    id: 'security-reviewer',
    name: 'Security Reviewer',
    tagline: 'OWASP, secrets, unsafe patterns, supply-chain risks.',
    approvalProfile: 'readOnly',
  },
  {
    id: 'typescript-reviewer',
    name: 'TypeScript Reviewer',
    tagline: 'Type safety, async correctness, idiomatic TS patterns.',
    approvalProfile: 'readOnly',
  },
  {
    id: 'python-reviewer',
    name: 'Python Reviewer',
    tagline: 'PEP 8, type hints, Pythonic idioms, async correctness.',
    approvalProfile: 'readOnly',
  },
  {
    id: 'rust-reviewer',
    name: 'Rust Reviewer',
    tagline: 'Ownership, lifetimes, unsafe usage, idiomatic patterns.',
    approvalProfile: 'readOnly',
  },
  {
    id: 'go-reviewer',
    name: 'Go Reviewer',
    tagline: 'Idiomatic Go, error handling, concurrency, allocations.',
    approvalProfile: 'readOnly',
  },
  {
    id: 'test-engineer',
    name: 'Test Engineer',
    tagline: 'TDD, coverage gaps, flaky test hardening.',
    approvalProfile: 'default',
  },
  {
    id: 'performance-optimizer',
    name: 'Performance Optimizer',
    tagline: 'Profiling, hot paths, bundle size, allocations.',
    approvalProfile: 'readOnly',
  },
  {
    id: 'doc-writer',
    name: 'Doc Writer',
    tagline: 'Concise technical docs, READMEs, API references.',
    approvalProfile: 'acceptEdits',
  },
];

export interface AgentCatalogPickerProps {
  /** When `false`, Modal renders nothing — same pattern as other overlays. */
  open: boolean;
  onClose: () => void;
  /**
   * Called when the user picks a template. The parent is responsible for
   * whatever follows: dispatching `/spawn <id> <task>` via the composer,
   * opening a task-input prompt, or sending a structured WS frame.
   */
  onLaunch: (templateId: string) => void;
}

export function AgentCatalogPicker({
  open,
  onClose,
  onLaunch,
}: AgentCatalogPickerProps): JSX.Element | null {
  const [filter, setFilter] = useState('');

  const filtered = useMemo<readonly AgentCatalogEntry[]>(() => {
    const q = filter.trim().toLowerCase();
    if (q.length === 0) return AGENT_CATALOG;
    return AGENT_CATALOG.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.id.toLowerCase().includes(q) ||
        e.tagline.toLowerCase().includes(q),
    );
  }, [filter]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sub-agent catalog"
      subtitle="Specialist templates — click to spawn a sub-agent with a curated system prompt."
      ariaLabel="Sub-agent catalog"
      icon={<Users size={16} strokeWidth={1.5} />}
      size="md"
    >
      <ModalBody>
        <input
          className={styles.search}
          type="text"
          placeholder="Filter by name, id, or tagline…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter templates"
        />
        <ul className={styles.list} role="list">
          {filtered.length === 0 ? (
            <li className={styles.empty}>No templates match the filter.</li>
          ) : (
            filtered.map((entry) => (
              <li key={entry.id} className={styles.item}>
                <button
                  type="button"
                  className={styles.card}
                  onClick={() => onLaunch(entry.id)}
                  aria-label={`Launch ${entry.name}`}
                >
                  <div className={styles.cardHead}>
                    <span className={styles.name}>{entry.name}</span>
                    <span
                      className={styles.profile}
                      data-profile={entry.approvalProfile}
                    >
                      {labelForProfile(entry.approvalProfile)}
                    </span>
                  </div>
                  <div className={styles.id}>{entry.id}</div>
                  <div className={styles.tagline}>{entry.tagline}</div>
                </button>
              </li>
            ))
          )}
        </ul>
      </ModalBody>
      <ModalFooter>
        <button type="button" className={styles.closeButton} onClick={onClose}>
          Close
        </button>
      </ModalFooter>
    </Modal>
  );
}

function labelForProfile(p: AgentApprovalProfile): string {
  switch (p) {
    case 'readOnly':
      return 'read-only';
    case 'acceptEdits':
      return 'auto-edits';
    case 'default':
      return 'default';
  }
}
