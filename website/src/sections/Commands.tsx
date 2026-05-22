import { motion } from 'framer-motion';
import { useI18n } from '../i18n';
import { staggerParent, tileReveal } from '../lib/motion';
import styles from './Commands.module.css';

// Slash command grid — surfaces the v0.21 verbs landing page visitors should
// know about (/web, /update, /diff, /branch, /spawn, /usage, /language, /undo).
export function Commands(): JSX.Element {
  const { t } = useI18n();

  return (
    <section className={styles.section} id="commands">
      <div className="container">
        <motion.h2
          className={styles.heading}
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-10%' }}
        >
          {t.commands.heading}
        </motion.h2>
        <motion.p
          className={styles.sub}
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-10%' }}
        >
          {t.commands.subheading}
        </motion.p>

        <motion.div
          className={styles.grid}
          variants={staggerParent}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-10%' }}
        >
          {t.commands.items.map((item) => (
            <motion.div key={item.cmd} variants={tileReveal} className={styles.card}>
              <span className={styles.cmd}>{item.cmd}</span>
              <p className={styles.body}>{item.body}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
