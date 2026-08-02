import { pino } from 'pino'
import { env } from './env.js'

/**
 * Application logger.
 *
 * The redaction list is a hard requirement, not a nicety: this app handles Todoist OAuth
 * tokens and a Glassfrog API key, and log output is the easiest way to leak them. Add a
 * path here whenever a new credential-shaped field appears.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'accessToken',
      'refreshToken',
      'apiKey',
      'password',
      'token',
      'secret',
      '*.accessToken',
      '*.refreshToken',
      '*.apiKey',
      '*.password',
      '*.token',
      '*.secret',
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      'headers["x-auth-token"]',
    ],
    censor: '[redacted]',
  },
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: true } } }
    : {}),
})

export type Logger = typeof logger
