import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves from /<repo>/ unless a custom domain is configured.
// Set VITE_BASE during build (workflow does this) to override.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? '/localcode/',
  build: {
    target: 'es2020',
    sourcemap: false,
    cssCodeSplit: false,
  },
});
