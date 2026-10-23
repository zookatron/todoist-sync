import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type IORedis from 'ioredis'

/*
 * ioredis-mock, made able to run BullMQ.
 *
 * ioredis-mock covers plain commands faithfully, but BullMQ does all its real work in Lua
 * scripts, and the mock's script support is thin: scripts run in fengari (Lua 5.3, 32-bit
 * integers) with no `cmsgpack`, no `cjson`, and a reply conversion that only recognises
 * tables built in one particular order. Each patch below fixes one of those, and none of
 * them changes what a script means — BullMQ itself runs unmodified on top.
 *
 * If a BullMQ upgrade breaks a test with "Error trying to loading or executing lua code",
 * the fix belongs in here or in `redis-compat.lua`, not in the code under test.
 */

type LuaState = object

type Fengari = {
  lua: {
    lua_pushstring(L: LuaState, value: Uint8Array): void
    lua_createtable(L: LuaState, arraySize: number, recordSize: number): void
    lua_rawseti(L: LuaState, index: number, key: number): void
  }
}

type FengariInterop = { push(L: LuaState, value: unknown): void } & { [PATCHED]?: true }

type Script = { numberOfKeys: number; lua: string }
type Command = (...args: unknown[]) => Promise<unknown>
type ReplyTransformer = (result: unknown, context?: unknown) => unknown

type RedisMock = {
  customCommands: Record<string, Command>
  defineCommand(name: string, script: Script): void
  duplicate(options?: object): RedisMock
} & Record<string, unknown>

type RedisMockClass = {
  new (options?: object): RedisMock
  Command: {
    transformers: { reply: Record<string, ReplyTransformer> }
    setReplyTransformer(name: string, transformer: ReplyTransformer): void
  }
}

const PATCHED: unique symbol = Symbol.for('todoist-sync.redis-mock.patched')

// Redis's Lua prints a whole float as `3`, Lua 5.3 as `3.0`, and BullMQ builds keys out
// of numbers. fengari reads this when it first loads, so it has to precede the require.
process.env.FENGARICONF = JSON.stringify({ LUA_COMPAT_FLOATSTRING: true })

const require = createRequire(import.meta.url)
const RedisMock = require('ioredis-mock') as RedisMockClass
const { lua } = require('fengari') as Fengari
const interop = require('fengari-interop') as FengariInterop

const PRELUDE = readFileSync(new URL('./redis-compat.lua', import.meta.url), 'utf8')
const POSTLUDE = '\nend)())'

/**
 * How ioredis-mock hands values to Lua — script arguments and `redis.call` replies.
 *
 * - **Buffers** become Lua strings. BullMQ msgpacks its options into a Buffer argument, and
 *   the mock would otherwise hand the script an opaque JavaScript object.
 * - **Arrays** become real Lua tables, not proxies of JavaScript arrays: `#`, `ipairs` and
 *   storing them in another table then behave as they do in Redis. The mock prefixes a
 *   `redis.call` reply with a dummy element (flagged by a `__len` symbol); drop it.
 *
 * Patched on the shared module, once per process — the mock reads `push` at call time.
 */
function patchLuaValues(): void {
  if (interop[PATCHED]) return
  interop[PATCHED] = true

  const push = interop.push.bind(interop)
  interop.push = (L, value) => {
    if (value instanceof Uint8Array) return lua.lua_pushstring(L, value)
    if (!Array.isArray(value)) return push(L, value)

    const items: unknown[] = Symbol.for('__len') in value ? value.slice(1) : value
    lua.lua_createtable(L, items.length, 0)
    items.forEach((item, index) => {
      // A nil inside a Redis array reply reaches Lua as false.
      interop.push(L, item ?? false)
      lua.lua_rawseti(L, -2, index + 1)
    })
  }
}

/**
 * ioredis 6 passes reply transformers a protocol context that ioredis-mock (written
 * against 5) does not; supply the RESP2 one it would have used.
 */
function patchReplyTransformers(): void {
  const { Command } = RedisMock
  for (const [name, transform] of Object.entries(Command.transformers.reply)) {
    if ((transform as { [PATCHED]?: true })[PATCHED]) continue
    const patched = (result: unknown, context: unknown = { protocol: 2, replyMapping: 'legacy' }) =>
      transform(result, context)
    Command.setReplyTransformer(name, Object.assign(patched, { [PATCHED]: true }))
  }
}

/**
 * Wraps every script in the compatibility prelude and decodes its reply, which the prelude
 * returns as JSON so the mock's own table conversion never sees it. Duplicates (BullMQ
 * makes one per blocking connection) are patched the same way.
 */
function patchClient(client: RedisMock): RedisMock {
  // BullMQ waits for a `ready` event unless `status` says it already happened, and the
  // mock, which emits that event once on construction, has no `status` at all.
  client.status = 'ready'

  const defineCommand = client.defineCommand.bind(client)
  client.defineCommand = (name, script) => {
    defineCommand(name, { ...script, lua: PRELUDE + script.lua + POSTLUDE })

    const run = client.customCommands[name]!
    const command: Command = async (...args) => {
      const reply = JSON.parse(String(await run(...args))) as unknown
      if (reply !== null && typeof reply === 'object' && 'err' in reply) {
        throw new Error(String(reply.err))
      }
      return reply
    }
    // Pipelines look scripts up in `customCommands`; direct calls use the method.
    client[name] = client.customCommands[name] = command
  }

  const duplicate = client.duplicate.bind(client)
  client.duplicate = (options) => patchClient(duplicate(options))
  return client
}

/** A fresh in-memory Redis that BullMQ can run on. */
export function createRedisMock(): IORedis {
  patchLuaValues()
  patchReplyTransformers()
  // `maxRetriesPerRequest: null` is what BullMQ demands of a real connection too.
  return patchClient(new RedisMock({ maxRetriesPerRequest: null })) as unknown as IORedis
}
