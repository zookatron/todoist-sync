import { router } from './init.js'
import { configRouter } from './routers/config.js'
import { syncRouter } from './routers/sync.js'

export const appRouter = router({
  config: configRouter,
  sync: syncRouter,
})

export type AppRouter = typeof appRouter
