import { router } from './init.js'
import { configRouter } from './routers/config.js'
import { syncRouter } from './routers/sync.js'
import { todoistRouter } from './routers/todoist.js'

export const appRouter = router({
  config: configRouter,
  sync: syncRouter,
  todoist: todoistRouter,
})

export type AppRouter = typeof appRouter
