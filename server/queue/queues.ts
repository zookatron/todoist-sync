import { type JobsOptions, Queue } from 'bullmq'
import IORedis from 'ioredis'
import { env } from '../utils/env.js'

/**
 * Shared Redis connection.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ: its blocking commands must not be
 * aborted by ioredis's retry cap.
 */
export const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
})

export const POLL_QUEUE = 'sync-poll'
export const TASK_QUEUE = 'sync-task'

export type PollJobData = { userId: string }

export type TaskJobData = {
  userId: string
  glassfrogActionId?: string
  todoistTaskId?: string
}

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: 500,
  removeOnFail: 1_000,
}

export const pollQueue = new Queue<PollJobData>(POLL_QUEUE, {
  connection,
  defaultJobOptions,
})

export const taskQueue = new Queue<TaskJobData>(TASK_QUEUE, {
  connection,
  defaultJobOptions,
})

/**
 * Stable identifier for a task sync job.
 *
 * A task that changed on both sides in the same poll produces one job, not two: BullMQ
 * refuses a duplicate job id while the original is still queued.
 */
export function taskJobId(data: TaskJobData): string {
  const key = data.glassfrogActionId ?? `td:${data.todoistTaskId}`
  return `task:${data.userId}:${key}`
}

/** Registers (or updates) the recurring poll for a user. */
export async function schedulePollForUser(userId: string): Promise<void> {
  await pollQueue.upsertJobScheduler(
    `poll:${userId}`,
    { every: env.SYNC_INTERVAL_MS },
    { name: 'poll', data: { userId } },
  )
}

export async function unschedulePollForUser(userId: string): Promise<void> {
  await pollQueue.removeJobScheduler(`poll:${userId}`)
}

export async function closeQueues(): Promise<void> {
  await Promise.all([pollQueue.close(), taskQueue.close()])
  await connection.quit()
}
