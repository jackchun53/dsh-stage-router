import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    projects: [
      {
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'unit',
          include: ['test/**/*.spec.ts'],
          exclude: ['test/integration/**', 'test/client/**'],
        },
      },
      {
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'client',
          include: ['test/client/**/*.spec.{ts,tsx}'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.spec.ts'],
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
})
