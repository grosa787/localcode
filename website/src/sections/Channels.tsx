import { motion } from 'framer-motion';
import { useI18n } from '../i18n';
import { staggerParent, tileReveal } from '../lib/motion';
import styles from './Channels.module.css';

interface Channel {
  readonly id: string;
  readonly label: string;
  readonly cmd: string;
  readonly ready: boolean;
}

const CHANNELS: ReadonlyArray<Channel> = [
  { id: 'curl', label: 'curl', cmd: 'curl -fsSL https://raw.githubusercontent.com/grosa787/localcode/main/install.sh | bash', ready: true },
  { id: 'npm', label: 'npm', cmd: 'npm install -g localcode', ready: false },
  { id: 'brew', label: 'Homebrew', cmd: 'brew install grosa787/tap/localcode', ready: false },
  { id: 'apt', label: 'apt', cmd: 'apt install localcode', ready: false },
  { id: 'dnf', label: 'dnf', cmd: 'dnf install localcode', ready: false },
];

export function Channels(): JSX.Element {
  const { t } = useI18n();

  return (
    <section className={styles.section}>
      <div className="container">
        <motion.h2
          className={styles.heading}
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-8%' }}
        >
          {t.channels.heading}
        </motion.h2>

        <motion.div
          className={styles.list}
          variants={staggerParent}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-10%' }}
        >
          {CHANNELS.map((c) => (
            <motion.div
              key={c.id}
              variants={tileReveal}
              className={`${styles.row} ${!c.ready ? styles.soon : ''}`}
            >
              <span className={styles.label}>{c.label}</span>
              <code className={styles.cmd}>{c.cmd}</code>
              {c.ready ? null : <span className={styles.badge}>{t.channels.soon}</span>}
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
