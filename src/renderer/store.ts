/**
 * 渲染进程的全局状态。
 *
 * 不引 pinia：状态量不大、层级也浅，一个 reactive 对象 + 一组动作足够，
 * 少一个依赖、少一层心智负担。
 * 事件订阅在这里统一登记（只登记一次），组件只管读 state。
 */
import { reactive, computed } from 'vue'
import type { MetaEnums } from '../shared/api'
import type {
  AppConfig,
  CaptureStatus,
  DanmakuMessage,
  DiskMonitorStatus,
  DiskUsage,
  HistoryItem,
  MonitorStats,
  RecordStats,
  RecordTaskState,
  Streamer,
  SystemInfo,
  Tag,
  TranscribeEnvironment
} from '../shared/types'

const api = window.api

export type ViewId =
  | 'dashboard'
  | 'monitor'
  | 'streamers'
  | 'recording'
  | 'library'
  | 'history'
  | 'transcribe'
  | 'tools'
  | 'capture'
  | 'logs'
  | 'settings'
  | 'about'

export interface DanmakuFeedItem {
  streamerId: string
  message: DanmakuMessage
}

export const state = reactive({
  ready: false,
  view: 'dashboard' as ViewId,

  config: null as AppConfig | null,
  meta: null as MetaEnums | null,
  system: null as SystemInfo | null,

  streamers: [] as Streamer[],
  tags: [] as Tag[],

  monitor: {
    running: false,
    taskCount: 0,
    livingCount: 0,
    checkedCount: 0,
    errorCount: 0
  } as MonitorStats,

  recordStats: { active: 0, totalToday: 0, bytesToday: 0, durationTodayMs: 0 } as RecordStats,
  activeRecords: [] as RecordTaskState[],

  history: [] as HistoryItem[],
  disk: null as DiskMonitorStatus | null,
  diskUsage: null as DiskUsage | null,
  hudi: null as CaptureStatus | null,
  transcribeEnv: null as TranscribeEnvironment | null,

  theme: 'light' as 'light' | 'dark',

  /** 实时弹幕（只保留最近 200 条） */
  danmakuFeed: [] as DanmakuFeedItem[],

  /** 后台任务进度（转写 / 合并 / 转码），用来在状态栏显示 */
  tasks: {
    transcribe: null as { done: number; total: number; message?: string } | null,
    merge: null as { done: number; total: number } | null,
    convert: null as { done: number; total: number } | null,
    import: null as { done: number; total: number } | null
  }
})

/* ============================ 派生 ============================ */

export const livingStreamers = computed(() => state.streamers.filter((s) => s.liveStatus === 'living'))

export const recordingIds = computed(() => new Set(state.activeRecords.map((r) => r.streamerId)))

export const autoRecordCount = computed(() => state.streamers.filter((s) => s.autoRecord).length)

export function platformColor(id: string): string {
  return state.meta?.platformMeta.find((p) => p.id === id)?.color ?? 'var(--ink-3)'
}

export function platformName(id: string): string {
  return (
    state.meta?.platformMeta.find((p) => p.id === id)?.name ??
    state.meta?.captureSources.find((c) => c.id === id)?.name ??
    id
  )
}

export function tagOf(id: string): Tag | undefined {
  return state.tags.find((t) => t.id === id)
}

/** 是否已加入监控但还没拿到直播间号（主播未开播，只给了主页） */
export function isPendingRoom(s: { roomId?: string; awaitingRoom?: boolean }): boolean {
  return !!s.awaitingRoom || (typeof s.roomId === 'string' && s.roomId.startsWith('sec:'))
}

/** 房间号显示：未开播的「待开播」主播不要露出 sec: 占位符 */
export function roomLabel(s: { roomId?: string; awaitingRoom?: boolean }): string {
  return isPendingRoom(s) ? '待开播 · 监控中' : (s.roomId ?? '—')
}

/* ============================ 动作 ============================ */

async function loadConfig(): Promise<void> {
  state.config = await api.config.get()
  state.theme = await resolveTheme()
}

async function resolveTheme(): Promise<'light' | 'dark'> {
  const t = await api.theme.get()
  return t.effective
}

export function applyTheme(): void {
  const root = document.documentElement
  root.dataset.theme = state.theme
  // Element Plus 的深色变量挂在 html.dark 上
  root.classList.toggle('dark', state.theme === 'dark')
}

export async function refreshStreamers(): Promise<void> {
  state.streamers = await api.streamer.list()
}

export async function refreshTags(): Promise<void> {
  state.tags = await api.tags.list()
}

export async function refreshHistory(): Promise<void> {
  state.history = await api.history.list()
}

export async function refreshStats(): Promise<void> {
  const [m, r, active] = await Promise.all([
    api.monitor.stats(),
    api.record.stats(),
    api.record.active()
  ])
  state.monitor = m
  state.recordStats = r
  state.activeRecords = active
}

export async function refreshDisk(): Promise<void> {
  const [st, usage] = await Promise.all([api.disk.status(), api.disk.usage()])
  state.disk = st
  state.diskUsage = usage
}

export async function refreshHudi(): Promise<void> {
  state.hudi = await api.hudi.status()
}

export async function refreshSystem(): Promise<void> {
  state.system = await api.system.info()
}

/** 一次性把首屏需要的都拉齐 */
export async function init(): Promise<void> {
  state.meta = await api.system.meta()
  await loadConfig()
  applyTheme()
  await Promise.all([
    refreshStreamers(),
    refreshTags(),
    refreshHistory(),
    refreshStats(),
    refreshDisk(),
    refreshHudi(),
    refreshSystem()
  ])
  state.ready = true
  bindEvents()
}

export async function setTheme(theme: 'light' | 'dark' | 'system'): Promise<void> {
  await api.theme.set(theme)
  state.config = await api.config.get()
  state.theme = await resolveTheme()
  applyTheme()
}

/**
 * 把 Vue 的 reactive/ref 代理对象转成可结构化克隆的纯对象。
 * Electron IPC 用 Structured Clone 序列化参数，Proxy（ref/reactive 包装后就是 Proxy）
 * 无法克隆，直接传会报 "An object could not be cloned."。
 * 所有传给 window.api 的对象参数，一律先过这个函数。
 */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T
}

export async function saveConfig(patch: Partial<AppConfig>): Promise<void> {
  const raw = plain(patch)
  state.config = await api.config.set(raw)
  if (raw.theme) {
    state.theme = await resolveTheme()
    applyTheme()
  }
  if (raw.disk) await refreshDisk()
}

/* ============================ 事件绑定 ============================ */

let bound = false

function bindEvents(): void {
  if (bound) return
  bound = true

  api.on.streamerChanged((list) => {
    state.streamers = list
  })
  api.on.streamerStatus((s) => {
    state.monitor = { ...state.monitor, taskCount: s.total, livingCount: s.living }
  })

  api.on.monitorStatus((s) => {
    state.monitor = s
  })

  api.on.taskChecked(({ streamerId, status, error }) => {
    const s = state.streamers.find((x) => x.id === streamerId)
    if (!s) return
    s.liveStatus = status as Streamer['liveStatus']
    s.lastCheckAt = Date.now()
    s.checkError = error
  })

  api.on.recordStatus((st) => {
    const i = state.activeRecords.findIndex((r) => r.id === st.id)
    if (i >= 0) state.activeRecords[i] = st
    else state.activeRecords.push(st)
    void api.record.stats().then((r) => {
      state.recordStats = r
    })
  })
  api.on.recordingEnded((st) => {
    state.activeRecords = state.activeRecords.filter((r) => r.id !== st.id)
    void refreshStats()
  })
  api.on.recordingError(() => {
    void refreshStats()
  })

  api.on.historyChanged((list) => {
    state.history = list
  })

  api.on.danmakuMessage(({ streamerId, message }) => {
    state.danmakuFeed.push({ streamerId, message: message as DanmakuMessage })
    if (state.danmakuFeed.length > 200) state.danmakuFeed.splice(0, state.danmakuFeed.length - 200)
  })

  api.on.transcribeProgress((p: any) => {
    if (p?.total != null) state.tasks.transcribe = { done: p.done ?? 0, total: p.total, message: p.message }
  })
  api.on.mergeProgress((p: any) => {
    if (p?.total != null) state.tasks.merge = { done: p.done ?? 0, total: p.total }
  })
  api.on.convertProgress((p: any) => {
    if (p?.total != null) state.tasks.convert = { done: p.done ?? 0, total: p.total }
  })
  api.on.importProgress((p: any) => {
    if (p?.total != null) state.tasks.import = { done: p.done ?? 0, total: p.total }
  })

  api.on.diskInfo((u) => {
    if ((u as DiskUsage).freeBytes != null) state.diskUsage = u as DiskUsage
    else state.disk = u as DiskMonitorStatus
  })

  api.on.hudiStatus((s) => {
    state.hudi = s
    void refreshStats()
  })

  api.on.configChanged((c) => {
    state.config = c
  })

  api.on.windowMaximized(() => {
    /* 标题栏自己订阅，这里不处理 */
  })
}
