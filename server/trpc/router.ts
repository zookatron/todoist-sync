import { router } from './init.js'
import { glassfrogRouter } from './routers/glassfrog.js'
import { syncRouter } from './routers/sync.js'
import { todoistRouter } from './routers/todoist.js'

export const appRouter = router({
  glassfrog: glassfrogRouter,
  sync: syncRouter,
  todoist: todoistRouter,
})

export type AppRouter = typeof appRouter
