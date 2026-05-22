import { motion } from 'framer-motion';
import { useI18n } from '../i18n';
import { staggerParent, tileReveal } from '../lib/motion';
import styles from './Privacy.module.css';

// Privacy + security section. Local-first messaging, no-telemetry promise,
// notarized release status, secret scanner.
export function Privacy(): JSX.Element {
  const { t } = useI18n();

  return (
    <section className={styles.section} id="privacy">
      <div className="container">
        <motion.h2
          className={styles.heading}
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-10%' }}
        >
          {t.privacy.heading}
        </motion.h2>

        <motion.div
          className={styles.grid}
          variants={staggerParent}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-10%' }}
        >
          {t.privacy.points.map((p) => (
            <motion.div key={p.title} variants={tileReveal} className={styles.point}>
              <h3 className={styles.title}>{p.title}</h3>
              <p className={styles.body}>{p.body}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
