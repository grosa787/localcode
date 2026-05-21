import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@web': resolve(__dirname, 'src'),
      '@protocol': resolve(__dirname, '../src/web/protocol'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
