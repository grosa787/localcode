import { motion } from 'framer-motion';
import { useI18n } from '../i18n';
import { useTheme } from '../theme/ThemeProvider';
import styles from './Nav.module.css';

export function Nav(): JSX.Element {
  const { t, locale, setLocale } = useI18n();
  const { theme, toggleTheme } = useTheme();

  return (
    <motion.nav
      className={styles.nav}
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      <div className={styles.brand}>
        <span className={styles.logo} aria-hidden="true">
          {/* Hand-drawn-looking glyph, not the standard rounded-square gradient */}
          <svg viewBox="0 0 32 32" width="28" height="28">
            <defs>
              <linearGradient id="navGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#7c3aed" />
                <stop offset="100%" stopColor="#a855f7" />
              </linearGradient>
            </defs>
            <path
              d="M8 10 L14 16 L8 22"
              fill="none"
              stroke="url(#navGrad)"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <line x1="17" y1="22" x2="25" y2="22" stroke="url(#navGrad)" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </span>
        <span className={styles.wordmark}>localcode</span>
      </div>

      <div className={styles.actions}>
        <a href="#features" className={styles.link}>{t.nav.features}</a>
        <a href="#install" className={styles.link}>{t.nav.install}</a>
        <a href="https://github.com/grosa787/localcode" className={styles.link} rel="noreferrer">
          {t.nav.github}
        </a>
        <button
          type="button"
          aria-label="Toggle theme"
          onClick={toggleTheme}
          className={styles.iconBtn}
          title={theme === 'dark' ? 'Light' : 'Dark'}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        <div className={styles.localeSwitch} role="group" aria-label="Locale">
          <button
            type="button"
            aria-pressed={locale === 'en'}
            onClick={() => setLocale('en')}
            className={`${styles.localeBtn} ${locale === 'en' ? styles.localeActive : ''}`}
          >
            EN
          </button>
          <button
            type="button"
            aria-pressed={locale === 'ru'}
            onClick={() => setLocale('ru')}
            className={`${styles.localeBtn} ${locale === 'ru' ? styles.localeActive : ''}`}
          >
            RU
          </button>
        </div>
      </div>
    </motion.nav>
  );
}
