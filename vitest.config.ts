import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['{server,app,worker}/**/*.test.ts'],
    setupFiles: ['./server/utils/test-setup.ts'],
    // No shared state between files: each one that touches the database owns a private
    // in-memory Postgres (see server/testing/database.ts), so they can run in parallel.
  },
  resolve: {
    alias: {
      '@server': resolve(import.meta.dirname, './server'),
      '~': resolve(import.meta.dirname, './app'),
    },
  },
})
