import type { JobsOptions } from 'bullmq'
import { afterAll, beforeEach } from 'vitest'
import {
  type PollJobData,
  type PollQueueLike,
  setPollQueue,
  setTaskQueue,
  type TaskJobData,
  type TaskQueueLike,
} from '../queue/queues.js'

export type RecordedJob<T> = {
  name: string
  data: T
  jobId?: string
}

/**
 * Records what would have been enqueued, instead of talking to Redis.
 *
 * Enough of BullMQ to make the poll path meaningful without a broker: the one behaviour
 * that carries real logic is duplicate-`jobId` rejection, which is what collapses a task
 * that changed on both sides into a single job (see `taskJobId` in
 * `server/queue/queues.ts`). Modelling it here means that collapse is actually tested
 * rather than assumed.
 */
class RecordingQueue<T> {
  readonly jobs: RecordedJob<T>[] = []
  private readonly liveIds = new Set<string>()

  add = (name: string, data: T, opts?: JobsOptions): Promise<unknown> => {
    const jobId = opts?.jobId

    // BullMQ refuses a job whose id is already queued. Silently, as here — the caller
    // gets a Job back either way, so nothing downstream can tell.
    if (jobId !== undefined && this.liveIds.has(jobId)) {
      return Promise.resolve(undefined)
    }
    if (jobId !== undefined) this.liveIds.add(jobId)

    this.jobs.push({ name, data, jobId })
    return Promise.resolve(undefined)
  }

  close = (): Promise<void> => Promise.resolve()

  reset(): void {
    this.jobs.length = 0
    this.liveIds.clear()
  }
}

/**
 * Substitutes both BullMQ queues for the duration of a test file.
 *
 * Instantiate at the top level; the constructor registers the vitest hooks.
 */
export class QueueSimulator {
  private readonly poll = new RecordingQueue<PollJobData>()
  private readonly task = new RecordingQueue<TaskJobData>()
  readonly schedulers = new Map<string, PollJobData | undefined>()

  constructor() {
    this.install()

    beforeEach(() => {
      this.reset()
      this.install()
    })

    afterAll(() => {
      setTaskQueue(null)
      setPollQueue(null)
    })
  }

  /** Jobs queued for per-task sync, in order. */
  get taskJobs(): RecordedJob<TaskJobData>[] {
    return this.task.jobs
  }

  /** Jobs queued for a poll cycle, in order. */
  get pollJobs(): RecordedJob<PollJobData>[] {
    return this.poll.jobs
  }

  /**
   * Runs `handler` over every queued task job, in order, then clears the queue.
   *
   * Lets a test drive a whole cycle — poll, then apply everything it produced — the way
   * the worker would, without running a worker.
   */
  async drainTaskJobs(handler: (job: RecordedJob<TaskJobData>) => Promise<void>): Promise<number> {
    const queued = [...this.task.jobs]
    this.task.reset()
    for (const job of queued) {
      await handler(job)
    }
    return queued.length
  }

  reset(): void {
    this.poll.reset()
    this.task.reset()
    this.schedulers.clear()
  }

  private install(): void {
    const pollQueue: PollQueueLike = {
      add: this.poll.add,
      close: this.poll.close,
      upsertJobScheduler: (id, _repeatOpts, template) => {
        this.schedulers.set(id, template?.data)
        return Promise.resolve(undefined)
      },
      removeJobScheduler: (id) => Promise.resolve(this.schedulers.delete(id)),
    }

    const taskQueue: TaskQueueLike = { add: this.task.add, close: this.task.close }

    setPollQueue(pollQueue)
    setTaskQueue(taskQueue)
  }
}
