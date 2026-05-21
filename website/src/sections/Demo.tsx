import { motion } from 'framer-motion';
import { useI18n } from '../i18n';
import styles from './Demo.module.css';

/**
 * Placeholder for the demo GIF. Sources are looked up at `docs/demo.gif`
 * (same repo); we resolve the path through `import.meta.env.BASE_URL` so
 * gh-pages subdir routing keeps working. When the gif is unavailable we
 * fall back to the styled placeholder block.
 */
export function Demo(): JSX.Element {
  const { t } = useI18n();
  const src = `${import.meta.env.BASE_URL}demo.gif`;

  return (
    <section className={styles.section}>
      <div className="container">
        <motion.h2
          className={styles.heading}
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-10%' }}
        >
          {t.demo.heading}
        </motion.h2>

        <motion.div
          className={styles.frame}
          initial={{ opacity: 0, y: 30, scale: 0.97 }}
          whileInView={{ opacity: 1, y: 0, scale: 1 }}
          viewport={{ once: true, margin: '-10%' }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Placeholder until docs/demo.gif is published. onError swaps it for the styled fallback. */}
          <img
            src={src}
            alt="LocalCode demo"
            className={styles.gif}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
          <div className={styles.placeholder}>
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.dot} aria-hidden="true" />
          </div>
          <p className={styles.caption}>{t.demo.caption}</p>
        </motion.div>
      </div>
    </section>
  );
}
