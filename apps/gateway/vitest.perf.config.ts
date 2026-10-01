import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/perf/**/*.perf.ts'],
    testTimeout: 300_000,
    hookTimeout: 180_000,
  },
});
