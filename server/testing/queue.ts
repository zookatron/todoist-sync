import type { Queue } from 'bullmq'
import { afterAll, beforeEach } from 'vitest'
import { type PollJobData, setPollQueue, setTaskQueue, type TaskJobData } from '../queue/queues.js'

export type RecordedJob<T> = {
  name: string
  data: T
}

/**
 * Records what would have been enqueued, instead of talking to Redis.
 *
 * Deliberately dumb: every `add` is recorded. Nothing passes a job id any more, so BullMQ
 * has no dedupe behaviour left to model — collapsing a task that changed on both sides is
 * done by the caller before it enqueues (see `taskJobKey` in `server/queue/queues.ts`),
 * and a test that asserts on `taskJobs` is therefore testing that collapse directly.
 */
class RecordingQueue<T> {
  readonly jobs: RecordedJob<T>[] = []

  add = (name: string, data: T): Promise<unknown> => {
    this.jobs.push({ name, data })
    return Promise.resolve(undefined)
  }

  close = (): Promise<void> => Promise.resolve()

  reset(): void {
    this.jobs.length = 0
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
    const pollQueue = {
      add: this.poll.add,
      close: this.poll.close,
      upsertJobScheduler: (
        id: string,
        _repeatOpts: unknown,
        template: { name?: string; data?: PollJobData },
      ) => {
        this.schedulers.set(id, template?.data)
        return Promise.resolve(undefined)
      },
    } as unknown as Queue<PollJobData>

    const taskQueue = {
      add: this.task.add,
      close: this.task.close,
    } as unknown as Queue<PollJobData>

    setPollQueue(pollQueue)
    setTaskQueue(taskQueue)
  }
}
