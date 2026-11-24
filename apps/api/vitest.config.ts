import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** Vitest projects: fast unit tests and Postgres-backed integration tests (the eval runs via scripts/eval.sh). */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/*.spec.ts'] } },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/**/*.int.spec.ts'],
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
