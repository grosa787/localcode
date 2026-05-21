import { AnimatePresence, motion } from 'framer-motion';
import { I18nProvider, useI18n } from './i18n';
import { ThemeProvider } from './theme/ThemeProvider';
import { Nav } from './components/Nav';
import { Hero } from './sections/Hero';
import { InstallPicker } from './sections/InstallPicker';
import { Features } from './sections/Features';
import { Surfaces } from './sections/Surfaces';
import { Demo } from './sections/Demo';
import { Channels } from './sections/Channels';
import { Footer } from './sections/Footer';

/**
 * Wraps the page so locale switches cross-fade instead of remounting hard.
 * Keyed by locale → AnimatePresence handles the transition.
 */
function Page(): JSX.Element {
  const { locale } = useI18n();
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={locale}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.25 }}
      >
        <Hero />
        <InstallPicker />
        <Features />
        <Surfaces />
        <Demo />
        <Channels />
      </motion.div>
    </AnimatePresence>
  );
}

export function App(): JSX.Element {
  return (
    <ThemeProvider>
      <I18nProvider>
        <Nav />
        <Page />
        <Footer />
      </I18nProvider>
    </ThemeProvider>
  );
}
