import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useI18n } from '../i18n';
import { CopyCmd } from '../components/CopyCmd';
import { INSTALL_COMMANDS, detectPlatform } from '../lib/platform';
import type { Platform } from '../lib/platform';
import { fadeUp } from '../lib/motion';
import styles from './InstallPicker.module.css';

const PLATFORM_ORDER: ReadonlyArray<Platform> = ['macos', 'linux', 'wsl', 'windows'];

export function InstallPicker(): JSX.Element {
  const { t } = useI18n();
  // SSR-stable default = macos. Refine after hydration.
  const [platform, setPlatform] = useState<Platform>('macos');

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  const labels: Record<Platform, string> = {
    macos: t.install.macos,
    linux: t.install.linux,
    wsl: t.install.wsl,
    windows: t.install.windows,
  };

  return (
    <section className={styles.section} id="install">
      <div className="container">
        <motion.h2
          className={styles.heading}
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-10%' }}
          variants={fadeUp}
        >
          {t.install.heading}
        </motion.h2>

        <motion.p
          className={styles.sub}
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-10%' }}
        >
          {t.install.subheading}
        </motion.p>

        <div className={styles.platformRow} role="tablist">
          {PLATFORM_ORDER.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={platform === p}
              onClick={() => setPlatform(p)}
              className={`${styles.platBtn} ${platform === p ? styles.platActive : ''}`}
            >
              {labels[p]}
            </button>
          ))}
        </div>

        <motion.div
          key={platform}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className={styles.cmdWrap}
        >
          <CopyCmd command={INSTALL_COMMANDS[platform]} />
        </motion.div>
      </div>
    </section>
  );
}
