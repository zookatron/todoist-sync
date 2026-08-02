import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['{server,app,worker}/**/*.test.ts'],
    setupFiles: ['./server/utils/test-setup.ts'],
    // Integration tests share one Postgres database; run files serially so
    // lock-table tests do not interfere with each other.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@server': resolve(import.meta.dirname, './server'),
      '~': resolve(import.meta.dirname, './app'),
    },
  },
})
