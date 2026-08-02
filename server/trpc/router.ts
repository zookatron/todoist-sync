import { router } from './init.js'
import { configRouter } from './routers/config.js'
import { glassfrogRouter } from './routers/glassfrog.js'
import { syncRouter } from './routers/sync.js'
import { todoistRouter } from './routers/todoist.js'

export const appRouter = router({
  config: configRouter,
  glassfrog: glassfrogRouter,
  sync: syncRouter,
  todoist: todoistRouter,
})

export type AppRouter = typeof appRouter
