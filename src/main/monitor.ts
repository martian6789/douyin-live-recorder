/**
 * 开播监控：轮询各主播的直播状态，开播即（按需）自动开录。
 *
 * 实现要点：
 * - 单一定时器扫描「到点的任务」，避免每个主播一个 setInterval。
 * - 状态变更批量回写 streamers.json（默认 10 秒 flush 一次），避免频繁写盘。
 * - 连续失败会指数退避，防止某个平台的接口挂了把整轮拖死。
 */
import { EventEmitter } from 'node:events'
import type { LiveStatus, MonitorStats, MonitorTask, PlatformId, Streamer } from '../shared/types'
import { getConfig, getCookie, getStreamers, setConfig, setStreamers } from './store'
import { getProvider } from './providers'
import { isPendingRoomId } from './providers/douyin'
import { resolveRoomIdBySecUid } from './douyin-search'
import { log } from './logger'

const L = log('monitor')
const TICK_MS = 1000
const FLUSH_MS = 10_000

interface RuntimeTask extends MonitorTask {
  backoffUntil: number
}

export const monitor = new EventEmitter()
monitor.setMaxListeners(0)

const tasks = new Map<string, RuntimeTask>()

let ticker: NodeJS.Timeout | null = null
let flushTimer: NodeJS.Timeout | null = null
let running = false
let checkedCount = 0
let errorCount = 0
let lastRoundAt = 0
let dirty = false
/** 正在探测中的房间，避免重复请求 */
const inFlight = new Set<string>()
/** 反查「待开播」主播直播间号的最小间隔：这类请求较重，串行化避免打太猛被风控 */
const RESOLVE_GAP_MS = 20_000
let lastResolveAt = 0

/* ============================ 任务管理 ============================ */

export function initFromStreamers(): void {
  const cfg = getConfig()
  tasks.clear()
  for (const s of getStreamers()) {
    tasks.set(s.id, {
      streamerId: s.id,
      platform: s.platform,
      roomId: s.roomId,
      name: s.name,
      enabled: true,
      intervalSec: cfg.checkIntervalSec,
      nextCheckAt: Date.now() + Math.random() * 3000,
      consecutiveErrors: 0,
      lastResult: s.liveStatus ?? 'unknown',
      backoffUntil: 0
    })
  }
  L.info('监控任务初始化', tasks.size)
}

export function addTask(s: Streamer): void {
  const cfg = getConfig()
  tasks.set(s.id, {
    streamerId: s.id,
    platform: s.platform,
    roomId: s.roomId,
    name: s.name,
    enabled: true,
    intervalSec: cfg.checkIntervalSec,
    nextCheckAt: Date.now(),
    consecutiveErrors: 0,
    lastResult: 'unknown',
    backoffUntil: 0
  })
  emitStatus()
}

export function removeTask(streamerId: string): void {
  tasks.delete(streamerId)
  emitStatus()
}

export function getTasks(): MonitorTask[] {
  return [...tasks.values()].map(({ backoffUntil, ...t }) => t)
}

/** 手动触发某个主播的探测（返回最新状态，并尝试触发自动录） */
export async function checkOne(streamerId: string): Promise<LiveStatus> {
  const t = tasks.get(streamerId)
  if (!t) return 'unknown'
  const status = await doCheck(t)
  // doCheck 内部只在 prev !== next 时 emit live-start。
  // 但「手动检测」是用户主动希望触发录制，必须无视 prev 重新发一次。
  if (status === 'living') monitor.emit('live-start', t.streamerId)
  return status
}

/* ============================ 调度 ============================ */

export function start(): void {
  if (running) return
  if (!tasks.size) initFromStreamers()
  running = true
  ticker = setInterval(tick, TICK_MS)
  flushTimer = setInterval(() => {
    if (dirty) {
      dirty = false
      void flushStreamers()
    }
  }, FLUSH_MS)
  monitor.emit('started')
  emitStatus()
  L.info('监控已启动')
  // 启动时立即对所有 autoRecord=true 的主播探测一次，是直播中就立刻开录
  void kickAutoRecordOnStartup()
}

/** 应用启动时立即检查所有 autoRecord=true 的主播，直播中即开录
 *  之前只在轮询发现状态切换时才触发，但每次启动只等下一次 tick 才有反应，
 *  且旧的 liveStatus='living' 不会被算成「状态切换」。
 *
 *  同时：若用户勾了主播级自动录，但全局开关仍是关，自动把全局打开。
 *  这与 toggleAuto 的行为对齐——用户认知只需要一层。*/
export async function kickAutoRecordOnStartup(): Promise<void> {
  const list = getStreamers().filter((s) => s.autoRecord)
  if (!list.length) return

  // 主播级有勾但全局没开 → 自动开全局
  const cur = getConfig()
  if (!cur.autoRecord) {
    setConfig({ autoRecord: true })
    L.info('启动自检：检测到主播级自动录勾选，自动打开「全局自动录制」')
  }

  L.info('启动自检：对 autoRecord 主播逐个探测', list.length)
  for (const s of list) {
    try {
      const status = await checkOne(s.id)
      if (status === 'living') {
        L.info('启动自检发现开播，立即开录', s.id, s.name)
        monitor.emit('live-start', s.id)
      }
    } catch (e: any) {
      L.warn('启动自检探测失败', s.id, e?.message ?? e)
    }
  }
}

export function stop(): void {
  running = false
  if (ticker) clearInterval(ticker)
  if (flushTimer) clearInterval(flushTimer)
  ticker = null
  flushTimer = null
  if (dirty) {
    dirty = false
    void flushStreamers()
  }
  monitor.emit('stopped')
  emitStatus()
  L.info('监控已停止')
}

export function isRunning(): boolean {
  return running
}

export function resumeTaskMonitoring(streamerIds?: string[]): void {
  for (const t of tasks.values()) {
    if (!streamerIds || streamerIds.includes(t.streamerId)) {
      t.enabled = true
      t.consecutiveErrors = 0
      t.backoffUntil = 0
      t.nextCheckAt = Date.now()
    }
  }
  emitStatus()
}

async function tick(): Promise<void> {
  const now = Date.now()
  const cfg = getConfig()
  const due: RuntimeTask[] = []
  for (const t of tasks.values()) {
    if (!t.enabled) continue
    if (t.backoffUntil > now) continue
    if (t.nextCheckAt > now) continue
    if (inFlight.has(t.streamerId)) continue
    due.push(t)
    if (due.length >= 8) break // 一轮最多并发 8 个探测
  }
  if (!due.length) return

  lastRoundAt = Date.now()
  await Promise.allSettled(due.map((t) => doCheck(t).then(() => void 0)))

  // 更新间隔（配置可能被改过）
  for (const t of tasks.values()) t.intervalSec = cfg.checkIntervalSec
}

async function doCheck(t: RuntimeTask): Promise<LiveStatus> {
  inFlight.add(t.streamerId)
  const cfg = getConfig()
  const provider = getProvider(t.platform)
  let roomId = t.roomId

  /* ---- 待开播主播：先用主页 sec_uid 反查直播间号，拿到才谈得上探测 ---- */
  if (isPendingRoomId(roomId)) {
    const now0 = Date.now()
    if (now0 - lastResolveAt < RESOLVE_GAP_MS) {
      inFlight.delete(t.streamerId)
      t.nextCheckAt = now0 + RESOLVE_GAP_MS
      return t.lastResult === 'living' ? 'living' : 'offline'
    }
    lastResolveAt = now0

    const secUid = roomId.slice(4)
    const r = await resolveRoomIdBySecUid(secUid)
    if (r.roomId) {
      roomId = r.roomId
      t.roomId = roomId
      t.consecutiveErrors = 0
      patchStreamer(t.streamerId, { roomId, awaitingRoom: false, checkError: undefined })
      L.info('待开播主播已开播，自动补上直播间号', { id: t.streamerId, roomId })
    } else {
      inFlight.delete(t.streamerId)
      t.consecutiveErrors = 0
      checkedCount += 1
      t.nextCheckAt = Date.now() + t.intervalSec * 1000
      t.lastResult = 'offline'
      patchStreamer(t.streamerId, {
        liveStatus: 'offline',
        lastCheckAt: Date.now(),
        checkError: r.error
      })
      monitor.emit('checked', t.streamerId, 'offline')
      return 'offline'
    }
  }

  try {
    const info = await provider.getRoomInfo(roomId, {
      ua: cfg.userAgent,
      cookie: getCookie(t.platform)
    })
    const next: LiveStatus = info.live ? 'living' : 'offline'
    const prev = t.lastResult
    t.lastResult = next
    t.consecutiveErrors = 0
    checkedCount += 1
    t.nextCheckAt = Date.now() + t.intervalSec * 1000

    const patch: Parameters<typeof patchStreamer>[1] = {
      liveStatus: next,
      lastCheckAt: Date.now(),
      checkError: undefined,
      roomTitle: info.title || undefined,
      coverUrl: info.cover || undefined,
      avatar: info.avatar || undefined,
      name: info.anchor || undefined
    }
    // 挖到主播主页 sec_uid 就补上（将来可按它反查直播间号），没有就别覆盖已有的
    if (info.secUid) patch.secUid = info.secUid
    patchStreamer(t.streamerId, patch)

    monitor.emit('checked', t.streamerId, next)
    if (prev !== next) {
      monitor.emit('stream-change', t.streamerId, next, prev)
      if (next === 'living') {
        monitor.emit('live-start', t.streamerId)
      } else if (prev === 'living') {
        monitor.emit('live-end', t.streamerId)
      }
    }
    return next
  } catch (e: any) {
    t.consecutiveErrors += 1
    errorCount += 1
    const backoff = Math.min(10 * 60_000, 15_000 * Math.pow(2, Math.min(5, t.consecutiveErrors)))
    t.backoffUntil = Date.now() + backoff
    t.nextCheckAt = Date.now() + t.intervalSec * 1000
    t.lastResult = 'error'
    patchStreamer(t.streamerId, {
      liveStatus: 'error',
      lastCheckAt: Date.now(),
      checkError: e?.message ?? String(e)
    })
    monitor.emit('checked', t.streamerId, 'error', e?.message ?? String(e))
    return 'error'
  } finally {
    inFlight.delete(t.streamerId)
  }
}

/* ============================ 状态回写 ============================ */

const patchBuffer = new Map<string, Partial<Streamer>>()

function patchStreamer(id: string, patch: Partial<Streamer>): void {
  const cur = patchBuffer.get(id) ?? {}
  patchBuffer.set(id, { ...cur, ...patch })
  dirty = true
}

async function flushStreamers(): Promise<void> {
  if (!patchBuffer.size) return
  const list = getStreamers()
  let changed = false
  for (const s of list) {
    const p = patchBuffer.get(s.id)
    if (!p) continue
    // 主播名只在不冲突时回填（用户可能手改过备注名）
    if (p.name && s.name && s.name !== p.name) delete (p as any).name
    Object.assign(s, p)
    changed = true
  }
  patchBuffer.clear()
  if (changed) {
    setStreamers(list)
    monitor.emit('persisted')
  }
}

/* ============================ 统计 ============================ */

export function stats(): MonitorStats {
  const all = [...tasks.values()]
  const cnt = { living: 0, error: 0 }
  for (const t of all) {
    if (t.lastResult === 'living') cnt.living += 1
    if (t.lastResult === 'error') cnt.error += 1
  }
  return {
    running,
    taskCount: all.length,
    livingCount: cnt.living,
    checkedCount,
    errorCount,
    lastRoundAt: lastRoundAt || undefined
  }
}

function emitStatus(): void {
  monitor.emit('status', stats())
}

export type { PlatformId }
