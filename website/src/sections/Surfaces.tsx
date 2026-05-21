import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useI18n } from '../i18n';
import styles from './Surfaces.module.css';

type Surface = 'tui' | 'web';

export function Surfaces(): JSX.Element {
  const { t } = useI18n();
  const [active, setActive] = useState<Surface>('tui');

  return (
    <section className={styles.section}>
      <div className="container">
        <motion.h2
          className={styles.heading}
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-8%' }}
        >
          {t.surfaces.heading}
        </motion.h2>

        <div className={styles.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={active === 'tui'}
            onClick={() => setActive('tui')}
            className={`${styles.tab} ${active === 'tui' ? styles.tabActive : ''}`}
          >
            {t.surfaces.tui}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={active === 'web'}
            onClick={() => setActive('web')}
            className={`${styles.tab} ${active === 'web' ? styles.tabActive : ''}`}
          >
            {t.surfaces.web}
          </button>
        </div>

        <div className={styles.stage}>
          <AnimatePresence mode="wait">
            {active === 'tui' ? (
              <motion.div
                key="tui"
                className={styles.frame}
                initial={{ opacity: 0, y: 24, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -16, scale: 0.99 }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
              >
                <TerminalMock />
              </motion.div>
            ) : (
              <motion.div
                key="web"
                className={styles.frame}
                initial={{ opacity: 0, y: 24, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -16, scale: 0.99 }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
              >
                <WebMock />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}

function TerminalMock(): JSX.Element {
  return (
    <div className={styles.tui}>
      <div className={styles.tuiHeader}>
        <span /><span /><span />
        <em>localcode  ·  ~/proj/api</em>
      </div>
      <pre className={styles.tuiBody}>
{`╭──────────────────────────────────────────────╮
│  localcode v0.20 — gpt-oss / openrouter      │
╰──────────────────────────────────────────────╯

> add rate-limit middleware to /search

  read_file     src/router.ts          (1.2 ms)
  read_file     src/middleware/auth.ts (0.8 ms)
  edit_file     src/middleware/rate.ts   [diff ↓]

  - // TODO: limit per IP
  + import { rateLimit } from '../lib/rate'
  + export const rateMW = rateLimit({ rpm: 60 })

  approve? (y/N) _`}
      </pre>
    </div>
  );
}

function WebMock(): JSX.Element {
  return (
    <div className={styles.web}>
      <div className={styles.webHeader}>
        <div className={styles.webDots}><span /><span /><span /></div>
        <div className={styles.webUrl}>localhost:5173 — localcode</div>
      </div>
      <div className={styles.webBody}>
        <aside className={styles.webSidebar}>
          <div className={styles.webNav}>· Chat</div>
          <div className={styles.webNav}>· Files</div>
          <div className={styles.webNav}>· Sessions</div>
          <div className={styles.webNav}>· Skills</div>
          <div className={styles.webNav}>· Plugins</div>
        </aside>
        <main className={styles.webMain}>
          <div className={styles.bubbleUser}>refactor handler, keep API</div>
          <div className={styles.bubbleAssistant}>
            <div className={styles.bubbleTool}>edit_file src/server.ts</div>
            Refactored handler — extracted error boundary into <code>errors.ts</code>.
          </div>
          <div className={styles.bubbleAssistant}>
            <em>streaming…</em>
          </div>
        </main>
      </div>
    </div>
  );
}
