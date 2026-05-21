/**
 * ImageAttachmentPreview — horizontal scrolling row of 64×64 thumbnails
 * for images the user has attached to the next Composer turn. Each
 * thumbnail carries a remove button; click → call `onRemove(id)`.
 *
 * Presentational: state ownership lives in the Composer.
 */

import { useMemo, type JSX } from 'react';

import { useT } from '../i18n';
import { X } from '../icons';

import styles from './ImageAttachmentPreview.module.css';

export interface ComposerImageAttachment {
  /** Stable client-only id used for keyed remove. */
  id: string;
  /** MIME type as reported by the source (e.g. `image/png`). */
  mimeType: string;
  /** Base64-encoded payload (no `data:` prefix). */
  base64: string;
  /** Byte count of the decoded payload — for the tooltip. */
  sizeBytes: number;
  /** Object-URL or `data:` URL used as the <img src>. */
  previewUrl: string;
  /** Optional source filename (if pasted from a file input or DnD). */
  name?: string;
  /** Optional decoded dimensions, populated after image load. */
  width?: number;
  height?: number;
}

export interface ImageAttachmentPreviewProps {
  /** Attached images, oldest first. */
  attachments: ComposerImageAttachment[];
  /** Remove handler — caller revokes the object URL. */
  onRemove: (id: string) => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImageAttachmentPreview(
  props: ImageAttachmentPreviewProps,
): JSX.Element | null {
  const t = useT();
  const { attachments, onRemove } = props;

  const items = useMemo(() => attachments, [attachments]);

  if (items.length === 0) return null;

  return (
    <div className={styles.row} role="list" aria-label={t('composer.attach.image')}>
      {items.map((att) => {
        const dim =
          att.width !== undefined && att.height !== undefined
            ? `${att.width}×${att.height}`
            : '—';
        const title = t('composer.attach.tooltip', {
          name: att.name ?? att.mimeType,
          size: formatBytes(att.sizeBytes),
          width: att.width ?? '?',
          height: att.height ?? '?',
        });
        return (
          <div
            key={att.id}
            className={styles.chip}
            role="listitem"
            title={title}
          >
            <img
              className={styles.thumb}
              src={att.previewUrl}
              alt={att.name ?? t('composer.attach.image')}
              draggable={false}
            />
            <button
              type="button"
              className={styles.remove}
              onClick={() => onRemove(att.id)}
              aria-label={t('composer.attach.removeAria')}
              title={t('composer.attach.remove')}
            >
              <X size={10} strokeWidth={2} />
            </button>
            <span className={styles.meta}>
              {formatBytes(att.sizeBytes)} · {dim}
            </span>
          </div>
        );
      })}
    </div>
  );
}
