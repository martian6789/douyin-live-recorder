/**
 * 录制引擎：解析流地址 → ffmpeg 落盘 → 弹幕同步归档 → 断流重连 → 写历史。
 *
 * 设计要点：
 * - 一次录制 = 一个 RecordTaskState。它可能产出多个文件（分段 + 重连后的新文件），
 *   全部记在 state.segments 里。
 * - 停止时优先往 ffmpeg stdin 写 `q` 优雅收尾；超时未退才强杀。
 * - 重连不改文件名策略：直接开新文件，避免半个文件被覆写。
 */
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type {
  DanmakuMessage,
  HistoryItem,
  PlatformId,
  RecordStats,
  RecordStatus,
  RecordTaskState,
  StreamVariant
} from '../shared/types'
import { getProvider } from './providers'
import { getConfig, getCookie, getHistory, setHistory, getStreamers, setStreamers } from './store'
import { buildRecordArgs, spawnFfmpeg } from './ffmpeg'
import { DanmakuWriter } from './danmaku'
import { danmakuHub } from './danmaku-hub'
import { renderTemplate } from './template'
import { log } from './logger'

const L = log('recorder')

export interface StartOptions {
  manual?: boolean
  quality?: string
  /** 覆盖输出目录（视频号捕获用） */
  outputDirOverride?: string
}

interface Task {
  state: RecordTaskState
  proc: ChildProcess | null
  writer: DanmakuWriter | null
  /** 渲染后的模板路径（不含扩展名） */
  basePath: string
  stopping: boolean
  timer: NodeJS.Timeout | null
  variant: StreamVariant | null
  /** 弹幕监听解绑 */
  offDanmaku: (() => void) | null
  /** 已产出的分段数（重连时接着编号） */
  producedCount: number
  stopReason: 'user' | 'stream-end' | 'error' | 'limit' | ''
}

export const recorder = new EventEmitter()
recorder.setMaxListeners(0)

const tasks = new Map<string, Task>()

function uid(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function extOf(): string {
  const c = getConfig().container
  return c === 'ts' ? 'ts' : c
}

function isDriveRoot(p: string): boolean {
  return /^[A-Za-z]:[\\/]$/.test(p) || p === '/'
}

/** 按模板算出输出基路径（不含扩展名），并保证目录存在 */
function computeBasePath(opts: {
  streamerName: string
  platform: PlatformId
  roomId: string
  title: string
  quality: string
  dirOverride?: string
  seq?: number
}): string {
  const cfg = getConfig()
  const root = opts.dirOverride || cfg.outputDir
  const rel = renderTemplate(cfg.template, {
    platform: opts.platform,
    name: opts.streamerName,
    roomId: opts.roomId,
    title: opts.title,
    quality: opts.quality,
    seq: opts.seq
  })
  const base = path.isAbsolute(rel) ? rel : path.join(root, rel)
  const dir = path.dirname(base)
  // Windows 不允许在盘符根目录调用 mkdirSync（会报 EPERM），
  // 而文件直接写在根目录通常是可以创建的，所以根目录跳过 mkdir。
  if (dir && !isDriveRoot(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return base
}

/** 同名文件已存在时追加 _2 _3 … */
function uniqueBase(base: string, ext: string): string {
  if (!fs.existsSync(`${base}.${ext}`)) return base
  for (let i = 2; i < 1000; i++) {
    if (!fs.existsSync(`${base}_${i}.${ext}`)) return `${base}_${i}`
  }
  return `${base}_${Date.now()}`
}

function emitUpdate(t: Task): void {
  recorder.emit('update', t.state)
}

/* ============================ 主流程 ============================ */

export async function startRecord(
  streamerId: string,
  opts: StartOptions = {}
): Promise<RecordTaskState> {
  const s = getStreamers().find((x) => x.id === streamerId)
  if (!s) throw new Error('主播不存在')
  if (tasks.has(streamerId)) return tasks.get(streamerId)!.state

  const cfg = getConfig()
  const manual = !!opts.manual

  // 并发限制
  const active = [...tasks.values()].filter((t) => !t.stopping)
  if (active.length >= cfg.maxConcurrent) {
    throw new Error(`已达到最大同时录制数（${cfg.maxConcurrent}）`)
  }
  const sameCount = active.filter((t) => t.state.platform === s.platform).length
  if (sameCount >= cfg.perPlatformLimit) {
    throw new Error(`该平台同时录制数已达上限（${cfg.perPlatformLimit}）`)
  }

  const quality = opts.quality || s.quality || cfg.quality[s.platform] || '原画'

  const state: RecordTaskState = {
    id: uid(),
    streamerId,
    platform: s.platform,
    roomId: s.roomId,
    streamerName: s.name,
    status: 'preparing',
    quality,
    manual,
    durationMs: 0,
    sizeBytes: 0,
    speed: '',
    segments: [],
    danmakuCount: 0,
    retries: 0
  }

  const task: Task = {
    state,
    proc: null,
    writer: null,
    basePath: '',
    stopping: false,
    timer: null,
    variant: null,
    offDanmaku: null,
    producedCount: 0,
    stopReason: ''
  }
  tasks.set(streamerId, task)
  emitUpdate(task)

  try {
    await runAttempt(task, s.platform, s.roomId, quality, opts)
  } catch (e: any) {
    task.state.status = 'error'
    task.state.error = e?.message ?? String(e)
    task.state.endedAt = Date.now()
    emitUpdate(task)
    recorder.emit('error', task.state)
    tasks.delete(streamerId)
    throw e
  }
  return task.state
}

async function runAttempt(
  task: Task,
  platform: PlatformId,
  roomId: string,
  quality: string,
  opts: StartOptions
): Promise<void> {
  const cfg = getConfig()
  const provider = getProvider(platform)

  task.state.status = 'preparing'
  emitUpdate(task)

  const info = await provider.getRoomInfo(roomId, { ua: cfg.userAgent, cookie: getCookie(platform) })
  const variants = await provider.getStreams(roomId, {
    ua: cfg.userAgent,
    cookie: getCookie(platform)
  })
  if (!variants.length) throw new Error('未取到可用直播流（可能未开播或需要 Cookie）')

  const variant = pickVariant(variants, quality)
  task.variant = variant
  task.state.quality = variant.label || quality
  task.state.title = info.title
  task.state.streamerName = info.anchor || task.state.streamerName

  // 输出路径
  const first = !task.basePath
  if (first) {
    task.basePath = uniqueBase(
      computeBasePath({
        streamerName: task.state.streamerName,
        platform,
        roomId,
        title: info.title,
        quality: task.state.quality ?? quality,
        dirOverride: opts.outputDirOverride
      }),
      extOf()
    )
  }

  const ext = extOf()
  const segmented = cfg.segmentMinutes > 0
  const output = segmented
    ? `${task.basePath}_%03d.${ext}`
    : task.producedCount === 0
      ? `${task.basePath}.${ext}`
      : `${task.basePath}_r${task.producedCount}.${ext}`

  // 弹幕归档（只在第一次尝试时建）
  if (first && cfg.saveDanmaku) {
    task.writer = new DanmakuWriter(path.dirname(task.basePath), path.basename(task.basePath), {
      saveJsonl: true,
      exportAss: cfg.exportAss
    })
  }

  const startedAt = task.state.startedAt ?? Date.now()
  task.state.startedAt = startedAt
  task.writer?.begin(startedAt)

  // 订阅弹幕：录制期间把该主播的消息写进文件
  if (task.writer) {
    attachDanmaku(task)
  }

  const args = buildRecordArgs({
    url: variant.url,
    output,
    variant,
    userAgent: cfg.userAgent,
    segmentMinutes: cfg.segmentMinutes,
    container: cfg.container
  })
  if (segmented && task.producedCount > 0) {
    args.splice(args.indexOf('-segment_time') + 2, 0, '-segment_start_number', String(task.producedCount))
  }
  // 进度走 stdout，便于界面显示码率和已写大小
  args.splice(1, 0, '-progress', 'pipe:1', '-stats_period', '1')

  const proc = spawnFfmpeg(args)
  task.proc = proc
  // 关键：stdin 的 error 事件必须有人接，否则退出时 stopRecord 对已关闭的
  // stdin write('q') 会抛 ERR_STREAM_WRITE_AFTER_END 变成 uncaught exception，
  // 主进程直接弹「A JavaScript error occurred in the main process」错误框。
  // （proc 自身有 on('error')，但 stdin 是独立的流，错误 emit 在它自己身上。）
  proc.stdin?.on('error', () => {
    /* 优雅停止写不进去是正常情况（进程已退出/管道已关），吞掉即可 */
  })
  task.state.status = 'recording'
  task.state.error = undefined
  task.state.endedAt = undefined
  emitUpdate(task)
  recorder.emit('started', task.state)

  let stderrTail = ''
  let currentOut = segmented
    ? `${task.basePath}_${String(task.producedCount).padStart(3, '0')}.${ext}`
    : output
  task.state.currentFile = currentOut

  proc.stdout?.on('data', (buf: Buffer) => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      const [k, v] = line.split('=')
      if (!k) continue
      if (k === 'out_time_us' || k === 'out_time_ms') {
        const us = Number(v)
        if (Number.isFinite(us) && us > 0) task.state.durationMs = Math.round(us / 1000)
      } else if (k === 'total_size') {
        const n = Number(v)
        if (Number.isFinite(n) && n > 0) task.state.sizeBytes = n
      } else if (k === 'speed') {
        task.state.speed = String(v).trim()
      }
    }
    emitUpdate(task)
  })

  proc.stderr?.on('data', (buf: Buffer) => {
    const text = buf.toString('utf8')
    stderrTail = (stderrTail + text).slice(-4000)
    // ffmpeg 的 segment muxer 会在开新段时打印文件名
    const m = /Opening '([^']+)' for writing/.exec(text)
    if (m && !task.state.segments.includes(m[1])) {
      task.producedCount += 1
      task.state.segments.push(m[1])
      task.state.currentFile = m[1]
      emitUpdate(task)
    }
  })

  // 兜底：定期刷新一次，保证界面上时长/大小是动的
  task.timer = setInterval(() => {
    syncSize(task)
    if (task.state.status === 'recording') emitUpdate(task)
  }, 1000)

  proc.on('error', (err) => {
    L.error('ffmpeg 进程错误', err)
    finalize(task, 1, String(err.message ?? err))
  })

  proc.on('exit', (code, signal) => {
    if (signal) L.warn('ffmpeg 被信号结束', signal)
    finalize(task, code ?? 0, stderrTail)
  })
}

function pickVariant(variants: StreamVariant[], want: string): StreamVariant {
  if (!want) return variants[0]
  const exact = variants.find((v) => v.label === want || v.quality === want)
  if (exact) return exact
  const idx = ['原画', '蓝光', '超清', '高清', '标清', '流畅'].indexOf(want)
  if (idx >= 0 && variants[idx]) return variants[idx]
  return variants[0]
}

function syncSize(task: Task): void {
  let total = 0
  for (const f of task.state.segments) {
    try {
      total += fs.statSync(f).size
    } catch {
      /* ignore */
    }
  }
  if (task.state.currentFile && !task.state.segments.includes(task.state.currentFile)) {
    try {
      total += fs.statSync(task.state.currentFile).size
    } catch {
      /* ignore */
    }
  }
  if (total > task.state.sizeBytes) task.state.sizeBytes = total
}

/** 把弹幕中心收到的消息接到录制文件上 */
function attachDanmaku(task: Task): void {
  const onMsg = (key: string, msg: DanmakuMessage): void => {
    if (key !== task.state.streamerId || !task.writer) return
    task.writer.push({
      platform: msg.platform,
      roomId: msg.roomId,
      type: msg.type,
      user: msg.user,
      uid: msg.uid,
      text: msg.text,
      color: msg.color,
      giftName: msg.giftName,
      giftCount: msg.giftCount,
      giftValue: msg.giftValue
    })
    task.state.danmakuCount = task.writer.count
  }
  danmakuHub.on('message', onMsg)
  task.offDanmaku = () => danmakuHub.off('message', onMsg)
  danmakuHub.subscribe(task.state.streamerId, task.state.platform, task.state.roomId)
}

/* ============================ 收尾 ============================ */

function finalize(task: Task, code: number, stderrTail: string): void {
  if (task.timer) {
    clearInterval(task.timer)
    task.timer = null
  }
  task.offDanmaku?.()
  task.offDanmaku = null

  const stopped = task.stopping
  const failed = !stopped && code !== 0

  if (failed && task.state.retries < getConfig().retryTimes) {
    task.state.retries += 1
    task.state.status = 'preparing'
    task.state.error = `断流/失败，第 ${task.state.retries} 次重连中…`
    emitUpdate(task)
    const delay = Math.max(1, getConfig().reconnectDelaySec) * 1000
    setTimeout(() => {
      if (task.stopping) return
      runAttempt(task, task.state.platform, task.state.roomId, task.state.quality ?? '', {}).catch(
        (e: any) => {
          task.state.status = 'error'
          task.state.error = e?.message ?? String(e)
          emitUpdate(task)
          finish(task)
        }
      )
    }, delay)
    return
  }

  if (failed) {
    task.state.status = 'error'
    task.state.error = `ffmpeg 退出码 ${code}：${stderrTail.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 500)}`
    recorder.emit('error', task.state)
  } else {
    task.state.status = 'done'
  }

  finish(task)
}

function finish(task: Task): void {
  task.state.endedAt = task.state.endedAt ?? Date.now()
  if (task.state.startedAt && !task.state.durationMs) {
    task.state.durationMs = (task.state.endedAt ?? Date.now()) - task.state.startedAt
  }
  syncSize(task)
  const dm = task.writer?.close()
  task.writer = null
  task.state.danmakuCount = dm?.count ?? task.state.danmakuCount

  const files = task.state.segments.length
    ? task.state.segments
    : task.state.currentFile
      ? [task.state.currentFile]
      : []

  // 写历史
  const items: HistoryItem[] = []
  let acc = 0
  for (const f of files) {
    let size = 0
    try {
      size = fs.statSync(f).size
    } catch {
      /* ignore */
    }
    if (!size) continue // 空文件不入库
    acc += size
    items.push({
      id: uid(),
      streamerId: task.state.streamerId,
      streamerName: task.state.streamerName,
      platform: task.state.platform,
      roomId: task.state.roomId,
      title: task.state.title,
      file: f,
      dir: path.dirname(f),
      sizeBytes: size,
      durationMs: task.state.durationMs,
      startedAt: task.state.startedAt ?? Date.now(),
      endedAt: task.state.endedAt ?? Date.now(),
      danmakuFile: dm?.jsonl,
      assFile: dm?.ass,
      quality: task.state.quality
    })
  }
  if (items.length) {
    setHistory([...items.reverse(), ...getHistory()])
    recorder.emit('history', items)
  }

  // 回填主播统计
  const list = getStreamers()
  const idx = list.findIndex((x) => x.id === task.state.streamerId)
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      recordCount: (list[idx].recordCount ?? 0) + (items.length ? 1 : 0),
      lastRecordAt: task.state.endedAt,
      lastFile: items[0]?.file ?? list[idx].lastFile
    }
    setStreamers(list)
  }

  task.state.status = task.state.status === 'error' ? 'error' : 'done'
  emitUpdate(task)
  recorder.emit('ended', task.state, items)
  tasks.delete(task.state.streamerId)
}

/* ============================ 对外控制 ============================ */

export async function stopRecord(streamerId: string, reason: Task['stopReason'] = 'user'): Promise<void> {
  const task = tasks.get(streamerId)
  if (!task) return
  task.stopping = true
  task.stopReason = reason
  task.state.status = 'stopping'
  emitUpdate(task)
  task.offDanmaku?.()
  task.offDanmaku = null

  const proc = task.proc
  if (!proc || proc.exitCode != null) {
    finish(task)
    return
  }

  try {
    const sin = proc.stdin
    if (sin && !sin.destroyed && !sin.writableEnded) {
      sin.write('q')
      sin.end()
    }
  } catch {
    /* ignore */
  }

  const killAt = Date.now() + 8000
  const wait = setInterval(() => {
    if (proc.exitCode != null || Date.now() > killAt) {
      clearInterval(wait)
      if (proc.exitCode == null) {
        L.warn('ffmpeg 未响应 q，强制结束', task.state.streamerId)
        try {
          proc.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }
  }, 300)
}

export function stopAll(): void {
  for (const id of [...tasks.keys()]) void stopRecord(id)
}

export function isRecording(streamerId: string): boolean {
  return tasks.has(streamerId)
}

export function listActive(): RecordTaskState[] {
  return [...tasks.values()].map((t) => t.state)
}

export function recordStats(): RecordStats {
  const active = listActive()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const hist = getHistory().filter((h) => h.endedAt >= today.getTime())
  return {
    active: active.length,
    totalToday: hist.length,
    bytesToday: hist.reduce((a, b) => a + b.sizeBytes, 0),
    durationTodayMs: hist.reduce((a, b) => a + b.durationMs, 0)
  }
}

export function activePlatformCount(platform: PlatformId): number {
  return [...tasks.values()].filter((t) => t.state.platform === platform).length
}
