import { useI18n } from '../i18n';
import styles from './Footer.module.css';

export function Footer(): JSX.Element {
  const { t } = useI18n();
  return (
    <footer className={styles.footer}>
      <div className={`container ${styles.inner}`}>
        <div className={styles.col}>
          <span className={styles.brand}>localcode</span>
          <p className={styles.tagline}>{t.footer.tagline}</p>
        </div>
        <div className={styles.col}>
          <a href="https://github.com/grosa787/localcode" rel="noreferrer">GitHub</a>
          <a href="https://github.com/grosa787/localcode/issues" rel="noreferrer">{t.footer.contactValue}</a>
        </div>
        <div className={styles.col}>
          <span>{t.footer.license}</span>
          <span>© {new Date().getFullYear()}</span>
        </div>
      </div>
    </footer>
  );
}
