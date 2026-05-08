import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'netlify/**/*.test.ts'],
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
      '@data': new URL('./src/data', import.meta.url).pathname,
    },
  },
});
