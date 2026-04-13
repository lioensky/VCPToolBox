export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

const DEFAULT_LEVEL: LogLevel = import.meta.env.DEV ? 'debug' : 'warn'

function resolveLogLevel(): LogLevel {
  const raw = import.meta.env.VITE_LOG_LEVEL
  if (!raw || typeof raw !== 'string') {
    return DEFAULT_LEVEL
  }

  const normalized = raw.toLowerCase()
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized
  }

  return DEFAULT_LEVEL
}

const configuredLevel = resolveLogLevel()

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[configuredLevel]
}

export interface Logger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`

  return {
    debug: (...args: unknown[]) => {
      if (!shouldLog('debug')) return
      console.log(prefix, ...args)
    },
    info: (...args: unknown[]) => {
      if (!shouldLog('info')) return
      console.info(prefix, ...args)
    },
    warn: (...args: unknown[]) => {
      if (!shouldLog('warn')) return
      console.warn(prefix, ...args)
    },
    error: (...args: unknown[]) => {
      if (!shouldLog('error')) return
      console.error(prefix, ...args)
    }
  }
}
