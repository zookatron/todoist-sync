import { destination, type LoggerOptions, pino } from 'pino'
import { env } from './env.js'

/**
 * Application logger.
 *
 * Values are logged as given, including credentials — this is an internal app and the log
 * file is a debugging tool, so a token in the log is a feature rather than a leak.
 */
const options: LoggerOptions = {
  level: env.LOG_LEVEL,
}

/**
 * Builds the log sink.
 *
 * With `LOG_FILE` set, every process opens the file in append mode (`O_APPEND`), which is
 * what makes a shared file safe: the kernel positions each write at the current end of
 * file, so two processes cannot overwrite each other. Log lines are far below the size at
 * which a single append could be split, so records do not interleave in practice. Pino's
 * default `pid` on every line is what tells the writers apart.
 *
 * Writes are synchronous. That costs throughput this app does not need, and buys the one
 * property a debugging log must have — a line survives the crash that immediately follows
 * it, instead of dying in a buffer.
 */
function createLogger() {
  if (env.LOG_FILE) {
    return pino(options, destination({ dest: env.LOG_FILE, append: true, mkdir: true, sync: true }))
  }

  if (env.NODE_ENV === 'development') {
    return pino({
      ...options,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: true } },
    })
  }

  return pino(options)
}

export const logger = createLogger()

export type Logger = typeof logger
