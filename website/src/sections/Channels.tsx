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

// Install channel ordering matches docs: curl first (the supported path),
// then apt / dnf (planned packages), then source build. npm was removed in
// v0.21 — there is no npm channel anymore.
const CHANNELS: ReadonlyArray<Channel> = [
  {
    id: 'curl',
    label: 'curl',
    cmd: 'curl -fsSL https://raw.githubusercontent.com/grosa787/localcode/main/install.sh | bash',
    ready: true,
  },
  { id: 'apt', label: 'apt', cmd: 'apt install localcode', ready: false },
  { id: 'dnf', label: 'dnf', cmd: 'dnf install localcode', ready: false },
  { id: 'brew', label: 'Homebrew', cmd: 'brew install grosa787/tap/localcode', ready: false },
  {
    id: 'source',
    label: 'source',
    cmd: 'git clone https://github.com/grosa787/localcode && cd localcode/localcode && ./install.sh',
    ready: true,
  },
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
