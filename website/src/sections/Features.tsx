import { motion } from 'framer-motion';
import { useI18n } from '../i18n';
import { TiltTile } from '../components/TiltTile';
import { Icon, isIconName } from '../components/icons';
import { staggerParent, tileReveal } from '../lib/motion';
import styles from './Features.module.css';

export function Features(): JSX.Element {
  const { t } = useI18n();

  return (
    <section className={styles.section} id="features">
      <div className="container">
        <motion.h2
          className={styles.heading}
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-8%' }}
        >
          {t.features.heading}
        </motion.h2>

        <motion.div
          className={styles.grid}
          variants={staggerParent}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-10%' }}
        >
          {t.features.tiles.map((tile, idx) => (
            <motion.div key={`${tile.title}-${idx}`} variants={tileReveal}>
              <TiltTile featured={idx === 0 || idx === 1}>
                <div className={styles.iconWrap}>
                  {isIconName(tile.icon) ? <Icon name={tile.icon} /> : null}
                </div>
                <h3 className={styles.title}>{tile.title}</h3>
                <p className={styles.body}>{tile.body}</p>
              </TiltTile>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
