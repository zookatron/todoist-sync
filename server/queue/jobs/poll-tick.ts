import { db } from '../../db/index.js'
import { todoistIntegration } from '../../db/schema/integrations.js'
import { logger } from '../../utils/logger.js'
import { getPollQueue, type PollJobData } from '../queues.js'

const log = logger.child({ job: 'poll-tick' })

/**
 * Runs on every global scheduler tick and fans out to one poll job per connected user.
 *
 * Enumerating users here — rather than registering a scheduler per user at worker boot —
 * is what lets a newly connected user start polling on the very next tick instead of
 * waiting for a worker restart.
 */
export async function runPollTick(): Promise<{ users: number }> {
  const connected = await db.select({ userId: todoistIntegration.userId }).from(todoistIntegration)

  for (const { userId } of connected) {
    const data: PollJobData = { userId }
    // Stable id: if the previous tick's poll for this user is still queued or running,
    // this tick's dispatch is a no-op rather than piling up a duplicate.
    await getPollQueue().add('poll', data, { jobId: `poll:${userId}` })
  }

  log.debug({ users: connected.length }, 'Dispatched poll tick')
  return { users: connected.length }
}
