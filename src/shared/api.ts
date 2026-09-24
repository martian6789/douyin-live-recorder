/**
 * preload 暴露给渲染进程的接口契约（纯类型，无实现）。
 *
 * 放在 shared 层的原因：
 * - preload 用它做「实现自检」——`const api: Api = {...}`，少写一个方法编译期就报错；
 * - 渲染进程用它声明 `window.api`，不必把 electron 的类型拖进 web 工程。
 */
import type {
  AddResult,
  AppConfig,
  CaptureConfig,
  CaptureSource,
  CaptureStatus,
  CredentialState,
  DiskMonitorStatus,
  DiskUsage,
  DouyinSearchResult,
  DouyinSearchUser,
  HistoryItem,
  ImportUsersResult,
  MonitorStats,
  MonitorTask,
  ParsedLink,
  PlatformId,
  RecordFile,
  RecordStats,
  RecordTaskState,
  RunningJob,
  Streamer,
  StreamerStats,
  StreamVariant,
  SystemInfo,
  Tag,
  TemplateVariable,
  TranscribeEnvironment,
  TranscribeSettings,
  UpdateCheckResult
} from './types'

export type Unsubscribe = () => void

export interface TemplateValidation {
  ok: boolean
  unknown: string[]
  normalized: string
  error?: string
}

export interface PlatformInfo {
  id: PlatformId
  name: string
  danmaku: boolean
}

export interface PlatformMetaInfo {
  id: PlatformId
  name: string
  color: string
  needsCookie: boolean
  danmaku: boolean
}

export interface MetaEnums {
  platforms: PlatformInfo[]
  platformMeta: PlatformMetaInfo[]
  captureSources: { id: string; name: string; color: string }[]
  qualities: readonly string[]
  referers: Record<string, string>
  relayPort: number
}

export interface AddStreamerInput {
  platform: PlatformId
  /** 链接或房间号；抖音也接受主播主页链接（未开播时用） */
  input: string
  /** 抖音 sec_uid：主播未开播、拿不到房间号时用它入库，开播后自动补房间号 */
  secUid?: string
  homeUrl?: string
  /** 抖音号（unique_id）：用于构造 live.douyin.com/<id> 直播链接 */
  douyinId?: string
  /** 直播页链接（live.douyin.com/<抖音号>） */
  liveUrl?: string
  avatar?: string
  name?: string
  remark?: string
  tags?: string[]
  autoRecord?: boolean
  quality?: string
  saveDir?: string
  danmakuEnabled?: boolean
}

export interface ScanSummary {
  count: number
  totalBytes: number
  todayCount: number
  todayBytes: number
  withDanmaku: number
  withSubtitle: number
}

export interface TranscribeScanItem {
  file: string
  name: string
  sizeBytes: number
  hasSubtitle?: boolean
}

export interface MergeGroupItem {
  output: string
  files: string[]
  dir: string
  totalBytes: number
  exists: boolean
}

export interface ConvertItemInfo {
  file: string
  name: string
  dir: string
  sizeBytes: number
}

export interface ConvertOptionsIO {
  container: 'mp4' | 'ts' | 'mkv' | 'flv'
  reencode?: boolean
  outDir?: string
  overwrite?: boolean
  deleteSource?: boolean
}

export interface NotifyTestResult {
  ok: boolean
  channels?: { channel: string; ok: boolean; error?: string }[]
  error?: string
}

export interface Api {
  app: {
    info: () => Promise<{ version: string; name: string; isPackaged: boolean }>
    getAutoStartup: () => Promise<boolean>
    setAutoStartup: (v: boolean) => Promise<boolean>
    checkUpdate: () => Promise<UpdateCheckResult>
    checkFirstRun: () => Promise<boolean>
    setFirstRunCompleted: () => Promise<boolean>
    openExternal: (url: string) => Promise<boolean>
    openLogDirectory: () => Promise<string>
    showInFolder: (p: string) => Promise<boolean>
    quit: () => Promise<void>
  }
  win: {
    minimize: (behavior?: 'taskbar' | 'tray') => Promise<void>
    toggleMaximize: () => Promise<boolean>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
  }
  config: {
    get: () => Promise<AppConfig>
    set: (patch: Partial<AppConfig>) => Promise<AppConfig>
    setMultiple: (patch: Partial<AppConfig>) => Promise<AppConfig>
    reset: () => Promise<AppConfig>
    selectDirectory: (title?: string) => Promise<string | null>
    openSaveDirectory: () => Promise<boolean>
    templateVariables: () => Promise<TemplateVariable[]>
    validateTemplate: (tpl: string) => Promise<TemplateValidation>
    previewTemplate: (tpl: string, sample?: Record<string, unknown>) => Promise<string>
  }
  credential: {
    all: () => Promise<CredentialState[]>
    set: (platform: PlatformId, cookie: string, accountName?: string) => Promise<boolean>
    clear: (platform: PlatformId) => Promise<boolean>
    validate: (platform: PlatformId) => Promise<{ valid: boolean; hint?: string }>
    /** 打开内置浏览器窗口让用户登录抖音 */
    douyinLoginOpen: () => Promise<boolean>
    /** 从内置窗口的会话里提取抖音 Cookie 并写入配置 */
    douyinLoginImport: () => Promise<{ ok: boolean; length?: number; error?: string }>
  }
  streamer: {
    list: () => Promise<Streamer[]>
    get: (id: string) => Promise<Streamer | null>
    byTags: (tagIds: string[]) => Promise<Streamer[]>
    stats: () => Promise<StreamerStats>
    refresh: () => Promise<Streamer[]>
    add: (input: AddStreamerInput) => Promise<{ streamer?: Streamer; created: boolean; list: Streamer[]; checkError?: string; error?: string }>
    batchAdd: (platform: PlatformId, text: string) => Promise<AddResult>
    /** 按昵称 / 抖音号在线搜抖音主播（需要抖音登录态 Cookie） */
    searchDouyin: (keyword: string) => Promise<DouyinSearchResult>
    /** 读取「我的关注」列表（需要抖音登录态），用于一键批量导入 */
    douyinFollowing: (maxPages?: number) => Promise<DouyinSearchResult>
    /** 批量导入抖音主播（搜索结果 / 关注列表） */
    importDouyinUsers: (users: DouyinSearchUser[], autoRecord?: boolean) => Promise<ImportUsersResult>
    /** 解析即添加：输入主播ID / 昵称 / 作品链接 / 主页链接 → 直接入库监控 */
    resolveAdd: (arg: {
      input: string
      autoRecord?: boolean
      danmakuEnabled?: boolean
    }) => Promise<{
      ok: boolean
      created?: boolean
      awaitingRoom?: boolean
      name?: string
      checkError?: string
      error?: string
      needCookie?: boolean
      candidates?: DouyinSearchUser[]
    }>
    update: (id: string, patch: Partial<Streamer>) => Promise<Streamer[]>
    remove: (id: string) => Promise<Streamer[]>
    toggleAutoRecord: (id: string) => Promise<boolean>
    toggleTop: (id: string) => Promise<Streamer[]>
    moveUp: (id: string) => Promise<Streamer[]>
    moveDown: (id: string) => Promise<Streamer[]>
    moveToBottom: (id: string) => Promise<Streamer[]>
    resetPosition: () => Promise<Streamer[]>
    checkExists: (
      platform: PlatformId,
      input: string
    ) => Promise<{ exists: boolean; streamer?: Streamer; roomId?: string | null }>
    batchCheckExists: (
      platform: PlatformId,
      inputs: string[]
    ) => Promise<{ input: string; exists: boolean; streamer?: Streamer }[]>
    exportData: () => Promise<{ ok: boolean; file?: string }>
    importData: () => Promise<{ ok: boolean; added?: number; skipped?: number; error?: string }>
    openSaveDirectory: (id: string) => Promise<boolean>
    initMonitor: () => Promise<MonitorTask[]>
  }
  tags: {
    list: () => Promise<Tag[]>
    add: (name: string, color?: string) => Promise<Tag[]>
    addBatch: (names: string[]) => Promise<Tag[]>
    update: (id: string, patch: { name?: string; color?: string }) => Promise<Tag[]>
    remove: (id: string) => Promise<Tag[]>
  }
  link: {
    parse: (input: string, platform?: PlatformId) => Promise<ParsedLink>
    batchParse: (text: string, platform?: PlatformId) => Promise<ParsedLink[]>
  }
  monitor: {
    tasks: () => Promise<MonitorTask[]>
    stats: () => Promise<MonitorStats>
    status: () => Promise<{ running: boolean; stats: MonitorStats }>
    start: () => Promise<MonitorStats>
    stop: () => Promise<MonitorStats>
    resume: (ids?: string[]) => Promise<MonitorTask[]>
    addTask: (id: string) => Promise<MonitorTask[]>
    removeTask: (id: string) => Promise<MonitorTask[]>
    checkOne: (id: string) => Promise<{ streamerId: string; status: string; error?: string }>
  }
  record: {
    start: (id: string, quality?: string) => Promise<RecordTaskState>
    stop: (id: string) => Promise<boolean>
    stopAll: () => Promise<boolean>
    isRecording: (id: string) => Promise<boolean>
    active: () => Promise<RecordTaskState[]>
    stats: () => Promise<RecordStats>
  }
  preview: {
    roomInfo: (
      platform: PlatformId,
      input: string
    ) => Promise<{ roomId: string; info: Record<string, unknown> }>
    streams: (platform: PlatformId, roomId: string) => Promise<StreamVariant[]>
    start: (
      platform: PlatformId,
      roomId: string
    ) => Promise<{
      port: number
      referer: string
      variants: (StreamVariant & { playUrl: string })[]
      transcodeUrl?: string
    }>
    stopAll: () => Promise<{ port: number }>
  }
  danmaku: {
    status: (id?: string) => Promise<unknown>
    setStreamerEnabled: (id: string, enabled: boolean) => Promise<unknown>
    subscribe: (id: string) => Promise<unknown>
    unsubscribe: (id: string) => Promise<unknown>
  }
  history: {
    list: () => Promise<HistoryItem[]>
    remove: (id: string) => Promise<HistoryItem[]>
    clear: () => Promise<HistoryItem[]>
    openDirectory: (dir: string) => Promise<boolean>
  }
  library: {
    scan: (opts?: {
      dir?: string
      recursive?: boolean
      since?: number
      keyword?: string
    }) => Promise<{ files: RecordFile[]; summary: ScanSummary }>
    removeFiles: (
      paths: string[],
      withCompanions?: boolean
    ) => Promise<{ removed: number; failed: string[] }>
    openFile: (p: string) => Promise<boolean>
    openDirectory: (dir: string) => Promise<boolean>
  }
  transcribe: {
    checkEnv: () => Promise<TranscribeEnvironment>
    getSettings: () => Promise<TranscribeSettings>
    saveSettings: (patch: Partial<TranscribeSettings>) => Promise<TranscribeSettings>
    scan: (dir?: string) => Promise<TranscribeScanItem[]>
    selectFiles: () => Promise<string[]>
    selectFolder: () => Promise<string | null>
    selectModelRoot: () => Promise<string | null>
    installDeps: () => Promise<boolean>
    downloadModels: () => Promise<boolean>
    startBatch: (files: (string | TranscribeScanItem)[]) => Promise<RunningJob[]>
    stop: () => Promise<boolean>
    deleteOutputs: (file: string) => Promise<string[]>
    jobs: () => Promise<RunningJob[]>
  }
  merger: {
    scan: (dir?: string) => Promise<MergeGroupItem[]>
    selectFolder: () => Promise<string | null>
    startBatch: (
      groups: MergeGroupItem[],
      opts?: { deleteSource?: boolean; overwrite?: boolean }
    ) => Promise<RunningJob[]>
    autoTasks: () => Promise<unknown[]>
    clearAutoTasks: () => Promise<unknown[]>
  }
  converter: {
    scan: (dir?: string) => Promise<ConvertItemInfo[]>
    selectFolder: () => Promise<string | null>
    startBatch: (items: ConvertItemInfo[], opts: ConvertOptionsIO) => Promise<RunningJob[]>
  }
  hudi: {
    status: () => Promise<CaptureStatus>
    sources: () => Promise<CaptureSource[]>
    audioDevices: () => Promise<string[]>
    setConfig: (patch: Partial<CaptureConfig>) => Promise<CaptureConfig>
    start: (override?: Partial<CaptureConfig>) => Promise<{ ok: boolean; file?: string }>
    stop: () => Promise<boolean>
  }
  disk: {
    usage: (target?: string) => Promise<DiskUsage>
    status: () => Promise<DiskMonitorStatus>
    restart: () => Promise<DiskMonitorStatus>
    runCheck: () => Promise<{ usage: DiskUsage; status: DiskMonitorStatus }>
  }
  notify: {
    test: () => Promise<NotifyTestResult>
  }
  log: {
    tail: (maxLines?: number) => Promise<{ file: string; lines: string[] }>
    write: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => Promise<boolean>
  }
  theme: {
    get: () => Promise<{ theme: 'light' | 'dark' | 'system'; effective: 'light' | 'dark' }>
    set: (theme: 'light' | 'dark' | 'system') => Promise<{ theme: string }>
  }
  system: {
    info: () => Promise<SystemInfo>
    openDevTools: () => Promise<boolean>
    meta: () => Promise<MetaEnums>
  }
  on: {
    recordStatus: (cb: (s: RecordTaskState) => void) => Unsubscribe
    recordingStarted: (cb: (s: RecordTaskState) => void) => Unsubscribe
    recordingEnded: (cb: (s: RecordTaskState) => void) => Unsubscribe
    recordingError: (cb: (s: RecordTaskState) => void) => Unsubscribe
    recordingStreamChange: (cb: (s: unknown) => void) => Unsubscribe

    monitorStatus: (cb: (s: MonitorStats) => void) => Unsubscribe
    monitorStarted: (cb: () => void) => Unsubscribe
    monitorStopped: (cb: () => void) => Unsubscribe
    taskChecked: (cb: (p: { streamerId: string; status: string; error?: string }) => void) => Unsubscribe
    taskCheckedBatch: (cb: (p: unknown) => void) => Unsubscribe
    taskStreamChange: (cb: (p: { streamerId: string; next: string; prev: string }) => void) => Unsubscribe

    streamerChanged: (cb: (list: Streamer[]) => void) => Unsubscribe
    streamerStatus: (cb: (s: StreamerStats) => void) => Unsubscribe

    configChanged: (cb: (c: AppConfig) => void) => Unsubscribe
    themeChanged: (cb: (p: { theme: string }) => void) => Unsubscribe

    danmakuMessage: (cb: (p: { streamerId: string; message: unknown }) => void) => Unsubscribe
    danmakuStatus: (cb: (s: unknown) => void) => Unsubscribe

    transcribeProgress: (cb: (p: unknown) => void) => Unsubscribe
    transcribeLocalInstall: (cb: (p: unknown) => void) => Unsubscribe
    mergeProgress: (cb: (p: unknown) => void) => Unsubscribe
    convertProgress: (cb: (p: unknown) => void) => Unsubscribe

    importProgress: (cb: (p: unknown) => void) => Unsubscribe
    importComplete: (cb: (p: unknown) => void) => Unsubscribe

    historyChanged: (cb: (list: HistoryItem[]) => void) => Unsubscribe

    diskWarning: (cb: (u: DiskUsage) => void) => Unsubscribe
    diskInfo: (cb: (u: DiskUsage | DiskMonitorStatus) => void) => Unsubscribe

    hudiStatus: (cb: (s: CaptureStatus) => void) => Unsubscribe
    hudiSources: (cb: (p: unknown) => void) => Unsubscribe

    windowMaximized: (cb: (v: boolean) => void) => Unsubscribe
    closeRequested: (cb: () => void) => Unsubscribe
    systemError: (cb: (m: string) => void) => Unsubscribe
  }
}
