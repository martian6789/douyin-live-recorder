/** 极简文件日志：按天滚动，落在数据目录的 logs/ 下。不引第三方依赖。 */
import fs from 'node:fs'
import path from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'

let logDir = ''
let stream: fs.WriteStream | null = null
let currentDay = ''

function day(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function initLogger(dir: string): void {
  logDir = dir
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }
}

export function getLogDir(): string {
  return logDir
}

function ensureStream(): fs.WriteStream | null {
  if (!logDir) return null
  const d = day()
  if (stream && currentDay === d) return stream
  try {
    stream?.end()
  } catch {
    /* ignore */
  }
  currentDay = d
  try {
    stream = fs.createWriteStream(path.join(logDir, `app-${d}.log`), { flags: 'a' })
  } catch {
    stream = null
  }
  return stream
}

/** 清掉超过 keepDays 天的日志 */
export function pruneLogs(keepDays = 14): void {
  if (!logDir) return
  try {
    const edge = Date.now() - keepDays * 86400_000
    for (const f of fs.readdirSync(logDir)) {
      const p = path.join(logDir, f)
      const st = fs.statSync(p)
      if (st.mtimeMs < edge) fs.unlinkSync(p)
    }
  } catch {
    /* ignore */
  }
}

function write(level: Level, scope: string, args: unknown[]): void {
  const line =
    `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ` +
    args
      .map((a) => {
        if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`
        if (typeof a === 'string') return a
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      })
      .join(' ')

  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)

  const s = ensureStream()
  s?.write(line + '\n')
}

export interface Logger {
  debug: (...a: unknown[]) => void
  info: (...a: unknown[]) => void
  warn: (...a: unknown[]) => void
  error: (...a: unknown[]) => void
}

const cache = new Map<string, Logger>()

export function log(scope: string): Logger {
  const hit = cache.get(scope)
  if (hit) return hit
  const l: Logger = {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a)
  }
  cache.set(scope, l)
  return l
}
