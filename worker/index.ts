import { Worker } from 'bullmq'
import { db, pool } from '../server/db/index.js'
import { todoistIntegration } from '../server/db/schema/integrations.js'
import { cleanupExpiredLocks } from '../server/utils/lock.js'
import { env } from '../server/utils/env.js'
import { logger } from '../server/utils/logger.js'
import { runPoll } from '../server/queue/jobs/poll.js'
import { runTaskSync } from '../server/queue/jobs/sync-task.js'
import {
  closeQueues,
  connection,
  POLL_QUEUE,
  type PollJobData,
  schedulePollForUser,
  TASK_QUEUE,
  type TaskJobData,
} from '../server/queue/queues.js'

const log = logger.child({ process: 'worker' })

/**
 * Registers a recurring poll for every user who has connected Todoist.
 *
 * Re-run at boot so schedulers survive a Redis flush, and so an interval change in the
 * environment takes effect (upsertJobScheduler updates an existing entry in place).
 */
async function registerSchedulers(): Promise<void> {
  const connected = await db.select({ userId: todoistIntegration.userId }).from(todoistIntegration)

  for (const { userId } of connected) {
    await schedulePollForUser(userId)
  }

  log.info(
    { users: connected.length, intervalMs: env.SYNC_INTERVAL_MS },
    'Registered poll schedulers',
  )
}

const pollWorker = new Worker<PollJobData>(POLL_QUEUE, async (job) => runPoll(job.data.userId), {
  connection,
  // One poll at a time: they are per-user and already lock-protected.
  concurrency: 1,
})

const taskWorker = new Worker<TaskJobData>(
  TASK_QUEUE,
  async (job) => runTaskSync(job.data, job.id ?? job.name),
  {
    connection,
    concurrency: 4,
    // Stay well inside both APIs' rate limits.
    limiter: { max: 30, duration: 1000 },
  },
)

pollWorker.on('failed', (job, error) => {
  log.error({ jobId: job?.id, err: error }, 'Poll job failed')
})

taskWorker.on('failed', (job, error) => {
  log.error({ jobId: job?.id, err: error }, 'Task sync job failed')
})

/** Housekeeping: expired locks are already stealable, this just bounds table growth. */
const lockJanitor = setInterval(
  () => {
    cleanupExpiredLocks().catch((error) => log.warn({ err: error }, 'Lock cleanup failed'))
  },
  60 * 60 * 1000,
)

let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  log.info({ signal }, 'Shutting down worker')
  clearInterval(lockJanitor)

  try {
    // Close workers first so in-flight jobs finish before their dependencies go away.
    await Promise.all([pollWorker.close(), taskWorker.close()])
    await closeQueues()
    await pool.end()
    log.info('Worker shut down cleanly')
    process.exit(0)
  } catch (error) {
    log.error({ err: error }, 'Error during shutdown')
    process.exit(1)
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

await registerSchedulers()
log.info('Worker ready')
