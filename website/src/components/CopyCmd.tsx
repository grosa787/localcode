import { useState } from 'react';
import { useI18n } from '../i18n';
import styles from './CopyCmd.module.css';

interface CopyCmdProps {
  readonly command: string;
  readonly variant?: 'hero' | 'inline';
}

export function CopyCmd({ command, variant = 'inline' }: CopyCmdProps): JSX.Element {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Some browsers (esp. iOS in non-secure context) fail silently — degrade to selection.
      const range = document.createRange();
      const code = document.getElementById('copy-cmd-text');
      if (code !== null) {
        range.selectNodeContents(code);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  };

  const cls = variant === 'hero' ? `${styles.wrap} ${styles.hero}` : styles.wrap;

  return (
    <div className={cls}>
      <code id="copy-cmd-text" className={styles.text}>{command}</code>
      <button
        type="button"
        onClick={handleCopy}
        className={styles.btn}
        aria-label="Copy install command"
      >
        {copied ? t.hero.copied : t.hero.copy}
      </button>
    </div>
  );
}
