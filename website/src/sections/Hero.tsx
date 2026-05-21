import { motion } from 'framer-motion';
import { useI18n } from '../i18n';
import { CopyCmd } from '../components/CopyCmd';
import { INSTALL_COMMANDS } from '../lib/platform';
import { fadeUp, staggerParent } from '../lib/motion';
import styles from './Hero.module.css';

export function Hero(): JSX.Element {
  const { t } = useI18n();

  return (
    <section className={styles.hero} id="hero">
      <div className={`container ${styles.inner}`}>
        <motion.div
          className={styles.copy}
          variants={staggerParent}
          initial="hidden"
          animate="visible"
        >
          <motion.div variants={fadeUp} className={styles.badge}>
            <span className={styles.pulse} aria-hidden="true" />
            v0.20 — local-first
          </motion.div>

          <motion.h1 variants={fadeUp} className={styles.headline}>
            {t.hero.tagline}
          </motion.h1>

          <motion.p variants={fadeUp} className={styles.sub}>
            {t.hero.subtitle}
          </motion.p>

          <motion.div variants={fadeUp} className={styles.installRow}>
            <CopyCmd command={INSTALL_COMMANDS.macos} variant="hero" />
          </motion.div>

          <motion.div variants={fadeUp} className={styles.meta}>
            <span>MIT</span>
            <span>·</span>
            <span>Bun + ink</span>
            <span>·</span>
            <span>macOS / Linux / WSL</span>
          </motion.div>
        </motion.div>

        {/* Decorative terminal preview — pure CSS, no images for fast first paint. */}
        <motion.div
          className={styles.term}
          initial={{ opacity: 0, x: 30, rotate: 2 }}
          animate={{ opacity: 1, x: 0, rotate: 1.5 }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
          aria-hidden="true"
        >
          <div className={styles.termBar}>
            <span /><span /><span />
            <em>localcode</em>
          </div>
          <pre className={styles.termBody}>
            <code>{'$ localcode\n> refactor this hotpath, keep public API\n  reading 4 files...\n  proposing edit (write_file: src/server.ts) [diff]\n  '}</code>
            <span className={styles.accent}>{'+ async function handleRequest(req: Req) {'}</span>
            <code>{'\n  approve? (y/N) '}</code>
            <span className={styles.cursor}>▌</span>
          </pre>
        </motion.div>
      </div>

      {/* Ambient glow blob — purely decorative. */}
      <div className={styles.glow} aria-hidden="true" />
    </section>
  );
}
