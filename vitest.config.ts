import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

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
        // The host supplies the primitives at runtime; their dependencies are not installed here.
        resolve: { alias: { '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./test/client/primitives-stub.tsx', import.meta.url)) } },
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
