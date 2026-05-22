/**
 * UpdateModal — VS-Code-style "Update available" dialog.
 *
 * Surfaces the GitHub-Releases delta between the running binary and the
 * most-recent published release. Three actions:
 *
 *   - **Install now** — kicks off the download (if not already staged)
 *     and tells the user to restart to apply.
 *   - **Remind me later** — dismisses for 24h via the parent updater.
 *   - **Skip this version** — persists the version to the on-disk skip
 *     list so future checks for the same version stay silent.
 *
 * The modal is opened by `setUpdateAvailable` in the store, fired when
 * the WS protocol delivers an `update_available` frame. ESC / backdrop
 * click route through `closeUpdateModal` (no opinion on persistence — a
 * casual close is equivalent to "Later").
 */

import { useMemo, type JSX } from 'react';

import { ModalFrame } from './ModalFrame';
import { useStore, type UpdateAvailableInfo } from '../state/store';

import styles from './UpdateModal.module.css';

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface UpdateModalProps {
  /** Override for tests; production uses the store payload. */
  readonly info?: UpdateAvailableInfo | null;
  /** Test hook fired when the user picks "Install now". */
  readonly onInstall?: (info: UpdateAvailableInfo) => void;
  /** Test hook fired when the user picks "Remind me later". */
  readonly onLater?: (dismissUntilMs: number) => void;
  /** Test hook fired when the user picks "Skip this version". */
  readonly onSkip?: (version: string) => void;
  /** Override `open` for tests. */
  readonly open?: boolean;
}

/**
 * Render the polished update dialog. Returns `null` when the modal is
 * closed or no payload is available so the parent layout collapses
 * cleanly.
 */
export function UpdateModal({
  info: infoOverride,
  onInstall,
  onLater,
  onSkip,
  open: openOverride,
}: UpdateModalProps = {}): JSX.Element | null {
  const storeInfo = useStore((s) => s.updateAvailable);
  const storeOpen = useStore((s) => s.updateModalOpen);
  const downloadedVersion = useStore((s) => s.updateDownloadedVersion);
  const close = useStore((s) => s.closeUpdateModal);

  const info = infoOverride ?? storeInfo;
  const open = openOverride ?? storeOpen;

  // Hooks must run unconditionally — compute body BEFORE the early
  // return so React's hook order stays stable when the modal toggles.
  // Prefer the concatenated delta notes when the server has supplied
  // them; fall back to the single-release `body` from the first WS
  // frame so the modal is never empty.
  const renderedBody = useMemo(() => {
    if (info === null) return '';
    const source =
      info.deltaNotes !== undefined && info.deltaNotes.trim().length > 0
        ? info.deltaNotes
        : info.body;
    return renderMarkdownLite(source);
  }, [info]);

  if (info === null || open === false) {
    return null;
  }

  const isStaged = downloadedVersion === info.latestVersion;

  const handleInstall = (): void => {
    onInstall?.(info);
    close();
  };

  const handleLater = (): void => {
    const until = Date.now() + DAY_MS;
    onLater?.(until);
    close();
  };

  const handleSkip = (): void => {
    onSkip?.(info.latestVersion);
    close();
  };

  return (
    <ModalFrame
      open
      onClose={close}
      title={`Update available: v${info.currentVersion} → v${info.latestVersion}`}
      subtitle={info.releaseName}
      size="lg"
      footer={
        <div className={styles.footer} data-testid="update-modal-footer">
          <button
            type="button"
            className={styles.ghost}
            data-testid="update-modal-skip"
            onClick={handleSkip}
          >
            Skip v{info.latestVersion}
          </button>
          <button
            type="button"
            className={styles.ghost}
            data-testid="update-modal-later"
            onClick={handleLater}
          >
            Remind me later
          </button>
          <button
            type="button"
            className={styles.primary}
            data-testid="update-modal-install"
            onClick={handleInstall}
          >
            {isStaged ? 'Restart to apply' : 'Install now'}
          </button>
        </div>
      }
    >
      <div className={styles.body} data-testid="update-modal-body">
        <p className={styles.intro}>
          A newer LocalCode release is ready. Review what changed below,
          then choose <strong>Install now</strong> to download it in the
          background. The new version applies on the next restart.
        </p>
        <div
          className={styles.notes}
          data-testid="update-modal-notes"
          dangerouslySetInnerHTML={{ __html: renderedBody }}
        />
        <p className={styles.meta}>
          <a
            href={info.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.link}
            data-testid="update-modal-link"
          >
            View on GitHub
          </a>
        </p>
      </div>
    </ModalFrame>
  );
}

/**
 * Minimal Markdown renderer for release notes — headings + lists +
 * paragraphs + inline code. Deliberately small to avoid pulling in a
 * dependency for one modal. HTML-escapes user input before applying
 * inline `<code>` so `dangerouslySetInnerHTML` cannot be exploited by a
 * compromised GitHub release.
 */
function renderMarkdownLite(input: string): string {
  if (input.length === 0) return '<p><em>No release notes provided.</em></p>';
  const escape = (s: string): string =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const lines = input.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push('');
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading !== null) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      const level = Math.min(6, heading[1]?.length ?? 1);
      const text = inlineFormat(escape(heading[2] ?? ''));
      out.push(`<h${level}>${text}</h${level}>`);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bullet !== null) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inlineFormat(escape(bullet[1] ?? ''))}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    out.push(`<p>${inlineFormat(escape(trimmed))}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

function inlineFormat(escaped: string): string {
  // Order matters — bold/italic before inline code so `*text*` inside
  // ``code`` does not accidentally get formatted.
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

export default UpdateModal;
