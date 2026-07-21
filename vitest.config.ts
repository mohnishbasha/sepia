import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '.vitest-cache',
  test: {
    environment: 'node',
    passWithNoTests: true,
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'types/**/*.ts',
        'config/**/*.ts',
        'serializer/**/*.ts',
        'resolver/**/*.ts',
        'fingerprint/**/*.ts',
        'privacy/**/*.ts',
        'telemetry/**/*.ts',
        'actions/**/*.ts',
        'engine/**/*.ts',
        'agent/**/*.ts',
        'interfaces/**/*.ts',
      ],
      exclude: ['tests/**', 'examples/**', 'dist/**', 'cli/**'],
    },
    reporters: ['verbose'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
