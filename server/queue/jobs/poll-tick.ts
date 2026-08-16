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
    // No explicit job id: a failed job would keep its id alive in the failed set and
    // silently swallow every later dispatch for that user. Overlap is handled instead by
    // the `poll:{userId}` lock in `runPoll`, which turns a redundant poll into a no-op.
    await getPollQueue().add('poll', data)
  }

  log.debug({ users: connected.length }, 'Dispatched poll tick')
  return { users: connected.length }
}
