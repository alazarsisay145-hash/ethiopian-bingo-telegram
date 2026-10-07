import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test-support.ts', 'src/integration-setup.ts', 'src/integration-support.ts', 'src/**/*.int.test.ts', 'src/infrastructure/db/**', 'src/infrastructure/redis/**', 'src/domain/ports.ts', 'src/main.ts'],
    },
  },
});
