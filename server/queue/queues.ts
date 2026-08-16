import { type JobsOptions, Queue } from 'bullmq'
import IORedis from 'ioredis'
import { env } from '../utils/env.js'

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

/*
 * Everything below is built on first use rather than at import.
 *
 * Constructing an ioredis client — or a BullMQ Queue over one — opens a socket
 * immediately, even with `lazyConnect`. Since `server/queue/jobs/poll.ts` imports this
 * module, an eager connection meant that merely importing the poll job reached for Redis,
 * which made the sync path impossible to test without a live server. Deferring the
 * construction keeps production behaviour identical (the first `add` connects, as before)
 * while letting tests substitute a queue before anything is built.
 */

let redis: IORedis | undefined
let realPollQueue: Queue<PollJobData> | undefined
let realTaskQueue: Queue<TaskJobData> | undefined

let pollQueueOverride: Queue<PollJobData> | undefined
let taskQueueOverride: Queue<TaskJobData> | undefined

/**
 * Shared Redis connection.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ: its blocking commands must not be
 * aborted by ioredis's retry cap.
 */
export function getConnection(): IORedis {
  return (redis ??= new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null }))
}

export function getPollQueue(): Queue<PollJobData> {
  if (pollQueueOverride) return pollQueueOverride
  return (realPollQueue ??= new Queue<PollJobData>(POLL_QUEUE, {
    connection: getConnection(),
    defaultJobOptions,
  }))
}

export function getTaskQueue(): Queue<TaskJobData> {
  if (taskQueueOverride) return taskQueueOverride
  return (realTaskQueue ??= new Queue<TaskJobData>(TASK_QUEUE, {
    connection: getConnection(),
    defaultJobOptions,
  }))
}

/** Test seams. Pass null to restore the real queue. */
export function setPollQueue(next: Queue<PollJobData> | null): void {
  pollQueueOverride = next ?? undefined
}

export function setTaskQueue(next: Queue<TaskJobData> | null): void {
  taskQueueOverride = next ?? undefined
}

/**
 * Stable identity for a task sync job, used to key the pending set within one poll cycle.
 *
 * A task that changed on both sides produces one job, not two. This is deliberately *not*
 * passed to BullMQ as a job id — a job that ends up in the failed set keeps its id, and
 * every later `add` under that id is dropped, so the task would never sync again.
 */
export function taskJobKey(data: TaskJobData): string {
  const key = data.glassfrogActionId ?? `td:${data.todoistTaskId}`
  return `task:${data.userId}:${key}`
}

export const POLL_TICK_JOB = 'poll-tick'

const GLOBAL_POLL_SCHEDULER_ID = 'global-poll'

/**
 * Registers (or updates) the single recurring tick that fans out to per-user poll jobs.
 *
 * There is exactly one of these, ever — it does not enumerate users itself, so a newly
 * signed-up user starts getting polled on the next tick rather than needing a worker
 * restart. See `runPollTick` for the fan-out.
 */
export async function scheduleGlobalPoll(): Promise<void> {
  await getPollQueue().upsertJobScheduler(
    GLOBAL_POLL_SCHEDULER_ID,
    { every: env.SYNC_INTERVAL_MS },
    { name: POLL_TICK_JOB },
  )
}

/** Closes only what was actually built, so this is safe to call in any process. */
export async function closeQueues(): Promise<void> {
  await Promise.all([realPollQueue?.close(), realTaskQueue?.close()])
  await redis?.quit()
}
