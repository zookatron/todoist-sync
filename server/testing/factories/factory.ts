export type Override<T> = Partial<T> | (() => Partial<T>) | (() => Promise<Partial<T>>)

export type Callback<T> = (data: T) => Promise<unknown>

/**
 * Remembers the entities a chain of factories has built.
 *
 * Without it, `new TaskMappingFactory().withUser()` and
 * `new ProjectMappingFactory().withUser()` would each create their own user and the two
 * rows would not relate. Sharing a context makes `withUser()` resolve to the *same* user
 * the second time, which is what lets a test describe a graph without threading ids by
 * hand.
 */
export class FactoryContext {
  private readonly instances = new Map<string, unknown>()

  get<T>(name: string): T | undefined {
    return this.instances.get(name) as T | undefined
  }

  set(name: string, instance: unknown): void {
    this.instances.set(name, instance)
  }
}

/**
 * Builds one database row, with chainable modifiers for the parts a test cares about.
 *
 * Subclasses supply `defaults()` (a complete, valid row) and `builder()` (the insert).
 * Everything a test varies goes through `override()` — including relations, which are
 * resolved lazily so `withUser()` only creates a user if one is actually needed.
 */
export abstract class Factory<T> {
  protected readonly context: FactoryContext
  private readonly overrides: Override<T>[] = []
  private readonly afters: Callback<T>[] = []

  constructor(context?: FactoryContext) {
    this.context = context ?? new FactoryContext()
  }

  protected abstract defaults(): Partial<T>
  protected abstract builder(data: T): Promise<T>

  override(override: Override<T>): this {
    this.overrides.push(override)
    return this
  }

  /** Runs after the row exists — for follow-up writes that need its generated id. */
  after(callback: Callback<T>): this {
    this.afters.push(callback)
    return this
  }

  make(): Promise<T>
  make(count: 1): Promise<T>
  make(count: number): Promise<T[]>
  async make(count = 1): Promise<T | T[]> {
    const results: T[] = []

    // Sequentially, not Promise.all: rows in one chain routinely depend on each other
    // (a mapping needs its user), and concurrent inserts would race the context.
    for (let index = 0; index < Math.max(1, count); index++) {
      let merged: Partial<T> = {}
      for (const override of this.overrides) {
        merged = { ...merged, ...(typeof override === 'function' ? await override() : override) }
      }
      results.push(await this.builder({ ...this.defaults(), ...merged } as T))
    }

    for (const result of results) {
      for (const callback of this.afters) {
        await callback(result)
      }
    }

    const first = results[0]
    if (first !== undefined) this.context.set(this.constructor.name, first)

    return count <= 1 ? (first as T) : results
  }

  /** The one this context already built, or a new one. */
  async findFromContextOrMake(): Promise<T> {
    return this.context.get<T>(this.constructor.name) ?? (await this.make())
  }
}
