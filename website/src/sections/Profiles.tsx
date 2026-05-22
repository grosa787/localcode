import { motion } from 'framer-motion';
import { useI18n } from '../i18n';
import { staggerParent, tileReveal } from '../lib/motion';
import styles from './Profiles.module.css';

// The five built-in permission profiles. Mirrors what /permissions exposes
// in the TUI — read-only, cautious, trusted-edits, trusted-shell, unrestricted.
export function Profiles(): JSX.Element {
  const { t } = useI18n();

  return (
    <section className={styles.section} id="profiles">
      <div className="container">
        <motion.h2
          className={styles.heading}
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-10%' }}
        >
          {t.profiles.heading}
        </motion.h2>
        <motion.p
          className={styles.sub}
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-10%' }}
        >
          {t.profiles.subheading}
        </motion.p>

        <motion.div
          className={styles.list}
          variants={staggerParent}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-10%' }}
        >
          {t.profiles.items.map((item, idx) => (
            <motion.div key={item.name} variants={tileReveal} className={styles.card}>
              <span className={styles.index}>0{idx + 1}</span>
              <h3 className={styles.name}>{item.name}</h3>
              <p className={styles.body}>{item.body}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
