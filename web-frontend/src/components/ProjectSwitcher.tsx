/**
 * ProjectSwitcher — collapsible sidebar footer pill.
 *
 * Collapsed: FolderOpen + project label + ChevronDown. Click expands an
 * inline list of "Recent projects" with a prominent "Open another folder…"
 * row at the bottom that opens AddProjectDialog.
 *
 * The open state is mirrored into the global store so other components
 * (e.g. ProjectBar's breadcrumb folder click) can request it open.
 */

import { useEffect, useState, type JSX } from 'react';

import { useT } from '../i18n';
import { ChevronDown, FolderOpen, Plus } from '../icons';
import { useStore } from '../state/store';
import { truncate } from '../util/truncate';
import styles from './ProjectSwitcher.module.css';

export interface ProjectSwitcherProps {
  onAddProject?: () => void;
}

export function ProjectSwitcher({
  onAddProject,
}: ProjectSwitcherProps): JSX.Element {
  const t = useT();
  const externalOpen = useStore((s) => s.projectSwitcherOpen);
  const closeSwitcher = useStore((s) => s.closeProjectSwitcher);
  const [localOpen, setLocalOpen] = useState(false);

  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const setActiveProject = useStore((s) => s.setActiveProject);

  // Sync external open requests into local state.
  useEffect(() => {
    if (externalOpen) {
      setLocalOpen(true);
      // Reset the flag so future requests retrigger.
      closeSwitcher();
    }
  }, [externalOpen, closeSwitcher]);

  const open = localOpen;
  const active = projects.find((p) => p.id === activeProjectId) ?? null;
  const label =
    active !== null ? truncate(active.label, 24) : t('projectSwitcher.noneSelected');

  return (
    <div className={styles.root}>
      {open ? (
        <div className={styles.list} role="listbox">
          <p className={styles.sectionHeader}>{t('projectSwitcher.recent')}</p>
          {projects.length === 0 ? (
            <p className={styles.empty}>{t('projectSwitcher.empty')}</p>
          ) : (
            projects.map((p) => (
              <button
                type="button"
                key={p.id}
                role="option"
                aria-selected={p.id === activeProjectId}
                className={`${styles.row} ${
                  p.id === activeProjectId ? styles.rowActive : ''
                }`}
                onClick={() => {
                  setActiveProject(p.id);
                  setLocalOpen(false);
                }}
              >
                <FolderOpen size={16} strokeWidth={1.5} />
                <span className={styles.rowLabel}>{truncate(p.label, 28)}</span>
              </button>
            ))
          )}
          <button
            type="button"
            className={styles.openAnother}
            onClick={() => {
              setLocalOpen(false);
              onAddProject?.();
            }}
          >
            <Plus size={16} strokeWidth={1.5} />
            <span className={styles.rowLabel}>{t('projectSwitcher.openAnother')}</span>
          </button>
        </div>
      ) : null}

      <button
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        onClick={() => setLocalOpen((v) => !v)}
      >
        <FolderOpen size={16} strokeWidth={1.5} />
        <span className={styles.triggerLabel}>{label}</span>
        <ChevronDown
          size={16}
          strokeWidth={1.5}
          className={`${styles.chev} ${open ? styles.chevOpen : ''}`}
        />
      </button>
    </div>
  );
}
