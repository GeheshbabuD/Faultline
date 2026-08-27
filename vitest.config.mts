import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@content': fileURLToPath(new URL('./content', import.meta.url)),
    },
  },
  test: {
    // jsdom takes 60s+ to initialise on Windows here, which trips vitest's
    // worker-startup timeout; happy-dom initialises in well under a second and
    // covers everything these component tests touch. One worker so the DOM
    // environment is paid for once.
    pool: 'threads',
    // Vitest 4 moved pool sizing to top-level options. One worker so the DOM
    // environment is initialised once rather than per worker.
    maxWorkers: 1,
    minWorkers: 1,
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/ai/**', 'src/server/**'],
    },
  },
});
