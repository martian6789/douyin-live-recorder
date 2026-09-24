/**
 * 主进程 / 渲染进程共享的数据类型 —— 本项目唯一的「契约层」。
 * 新增平台、新增录制后端、新增功能模块都只依赖这里的定义，彼此不耦合。
 */

/* ============================ 平台 ============================ */

/** 走公开 Web 接口拉流的平台。新增平台：这里加一项 → providers 注册一行。 */
export type PlatformId = 'bilibili' | 'douyu' | 'huya' | 'douyin' | 'kuaishou'

/** 视频号：没有公开接口，走「捕获」模式录制（原版走系统代理 MITM，本项目不采用） */
export type CaptureId = 'hudi'

/** 所有可被监控/录制的来源 */
export type SourceId = PlatformId | CaptureId

export interface PlatformMeta {
  id: PlatformId
  name: string
  color: string
  /** 是否需要 Cookie 才能拿到完整信息 */
  needsCookie: boolean
  /** 弹幕是否支持 */
  danmaku: boolean
}

export const PLATFORMS: PlatformMeta[] = [
  { id: 'bilibili', name: '哔哩哔哩', color: '#23ade5', needsCookie: false, danmaku: true },
  { id: 'douyu', name: '斗鱼', color: '#ff5d23', needsCookie: false, danmaku: true },
  { id: 'huya', name: '虎牙', color: '#ffa200', needsCookie: false, danmaku: false },
  { id: 'douyin', name: '抖音', color: '#161823', needsCookie: true, danmaku: false },
  { id: 'kuaishou', name: '快手', color: '#ff4906', needsCookie: true, danmaku: false }
]

export const CAPTURE_SOURCES: { id: CaptureId; name: string; color: string }[] = [
  { id: 'hudi', name: '微信视频号', color: '#07c160' }
]

export const QUALITY_PRESETS = ['原画', '蓝光', '超清', '高清', '标清', '流畅'] as const
export type QualityPreset = (typeof QUALITY_PRESETS)[number]

export type LiveStatus = 'unknown' | 'checking' | 'offline' | 'living' | 'error'
export type RecordStatus = 'idle' | 'preparing' | 'recording' | 'stopping' | 'error' | 'done'

/* ============================ 拉流（provider 层） ============================ */

export type StreamFormat = 'hls' | 'flv' | 'rtmp' | 'mp4'
export type DanmakuType = 'chat' | 'gift' | 'superchat' | 'enter' | 'like' | 'system'

export interface RoomInfo {
  platform: PlatformId
  roomId: string
  title: string
  anchor: string
  /** 主播主页 sec_uid（抖音页面里能挖到）：存下来后可据此反查直播间号 */
  secUid?: string
  avatar?: string
  cover?: string
  live: boolean
  audience?: number
  startedAt?: number
}

export interface StreamVariant {
  quality: string
  label: string
  url: string
  format: StreamFormat
  headers?: Record<string, string>
}

/** 抖音「搜主播」结果里的一项 */
export interface DouyinSearchUser {
  secUid: string
  nickname: string
  /** 抖音号（unique_id / short_id） */
  douyinId: string
  signature?: string
  followers?: number
  avatar?: string
  living?: boolean
  /** 直播间号 web_rid；只有开播中的主播才拿得到 */
  roomId?: string
  roomUrl?: string
  homeUrl?: string
  /** 直播页链接（live.douyin.com/<抖音号>），用于直接打开/监控 */
  liveUrl?: string
}

/** 批量导入主播的结果统计 */
export interface ImportUsersResult {
  added: number
  skipped: number
  failed: number
  errors: string[]
}

/** 抖音「搜主播」的整包结果 */
export interface DouyinSearchResult {
  ok: boolean
  users: DouyinSearchUser[]
  error?: string
  /** 缺 Cookie / Cookie 过期时为 true，界面据此引导登录 */
  needCookie?: boolean
  /** 「我的关注」场景：本次扫描到多少个关注 */
  scanned?: number
}

export interface DanmakuMessage {
  seq: number
  ts: number
  offset: number
  platform: PlatformId
  roomId: string
  type: DanmakuType
  user: string
  uid: string
  text: string
  color?: string
  giftName?: string
  giftCount?: number
  giftValue?: number
}

/* ============================ 标签 / 主播库 ============================ */

export interface Tag {
  id: string
  name: string
  color: string
  createdAt: number
}

export interface Streamer {
  id: string
  platform: PlatformId
  roomId: string
  /** 主播名，首次探测成功后回填；用户也可手改 */
  name: string
  /**
   * 抖音主页 sec_uid。
   * 场景：只知道主播名字但对方还没开播 —— 抖音此时根本不存在对外的直播间号，
   * 只有主页地址是永久固定的。存下它，监控轮询时一旦开播就能自动抓到直播间号。
   */
  secUid?: string
  /** 主播主页地址（抖音：https://www.douyin.com/user/<sec_uid>） */
  homeUrl?: string
  /** 抖音号（unique_id）：用于构造 live.douyin.com/<id> 直播链接，也便于二次检索 */
  douyinId?: string
  /** 直播页链接（live.douyin.com/<抖音号>）：一键打开 / 直接监控 */
  liveUrl?: string
  /** true = 已加入监控、但还没拿到直播间号（等开播自动补） */
  awaitingRoom?: boolean
  avatar?: string
  roomTitle?: string
  coverUrl?: string
  remark?: string
  /** 关联标签 id */
  tags: string[]
  /** 单独保存目录，留空用全局 */
  saveDir?: string
  /** 开播自动录制 */
  autoRecord: boolean
  /** 置顶 */
  top: boolean
  /** 手动排序权重，越小越靠前 */
  order: number
  /** 清晰度偏好，留空用全局 */
  quality?: string
  /** 是否录该主播的弹幕 */
  danmakuEnabled: boolean

  createdAt: number
  updatedAt: number

  /* ---- 运行态（低频落盘） ---- */
  liveStatus?: LiveStatus
  lastCheckAt?: number
  checkError?: string
  lastLiveAt?: number
  recordCount?: number
  lastRecordAt?: number
  lastFile?: string
}

export interface StreamerStats {
  total: number
  living: number
  autoRecord: number
  byPlatform: Record<string, number>
  todayNew: number
}

/* ============================ 开播监控 ============================ */

export interface MonitorTask {
  streamerId: string
  platform: PlatformId
  roomId: string
  name: string
  enabled: boolean
  intervalSec: number
  nextCheckAt: number
  consecutiveErrors: number
  lastResult?: LiveStatus
}

export interface MonitorStats {
  running: boolean
  taskCount: number
  livingCount: number
  checkedCount: number
  errorCount: number
  lastRoundAt?: number
}

/* ============================ 录制 ============================ */

export interface RecordTaskState {
  id: string
  streamerId: string
  platform: PlatformId
  roomId: string
  streamerName: string
  title?: string
  status: RecordStatus
  quality?: string
  manual: boolean
  startedAt?: number
  endedAt?: number
  durationMs: number
  sizeBytes: number
  speed: string
  /** 当前正在写的分段文件 */
  currentFile?: string
  /** 本次录制产出的所有分段 */
  segments: string[]
  danmakuCount: number
  retries: number
  error?: string
}

export interface RecordStats {
  active: number
  totalToday: number
  bytesToday: number
  durationTodayMs: number
}

/* ============================ 视频号捕获 ============================ */

export type CaptureMode = 'screen' | 'window'

export interface CaptureSource {
  id: string
  name: string
  mode: CaptureMode
  thumbnail?: string
}

export interface CaptureConfig {
  mode: CaptureMode
  sourceId?: string
  sourceName?: string
  /** dshow 音频设备名，留空则不录声音 */
  audioDevice?: string
  fps: number
  quality: QualityPreset
  /** 区域裁剪（仅 screen 模式），留空为全屏 */
  crop?: { x: number; y: number; w: number; h: number }
  /** 录制时长上限（分钟后自动停），0 = 不限 */
  maxMinutes: number
  saveDir?: string
  name?: string
}

export interface CaptureStatus {
  ready: boolean
  ffmpeg: FfmpegStatus
  sources: CaptureSource[]
  audioDevices: string[]
  config: CaptureConfig
  recording: boolean
  taskId?: string
  error?: string
}

/* ============================ 录像库 / 历史 ============================ */

export interface RecordFile {
  path: string
  name: string
  dir: string
  sizeBytes: number
  mtime: number
  ext: string
  danmakuFile?: string
  assFile?: string
  subFiles?: string[]
  durationMs?: number
  /** 从目录结构推断 */
  platform?: string
  streamerName?: string
}

export interface HistoryItem {
  id: string
  streamerId?: string
  streamerName: string
  platform: SourceId
  roomId: string
  title?: string
  file: string
  dir: string
  sizeBytes: number
  durationMs: number
  startedAt: number
  endedAt: number
  danmakuFile?: string
  assFile?: string
  quality?: string
  merged?: boolean
  transcribed?: boolean
}

/* ============================ 转写 / 合并 / 转码 ============================ */

export type TranscribeEngine = 'funasr' | 'whisper'
export type TranscribeFormat = 'txt' | 'srt' | 'vtt' | 'json'
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface TranscribeSettings {
  engine: TranscribeEngine
  /** 本地模型根目录 */
  modelRoot: string
  /** python 可执行文件，留空自动探测 */
  pythonPath: string
  /** 转写脚本路径，留空用内置 resources/funasr_runner.py */
  runnerPath: string
  format: TranscribeFormat
  /** 是否把字幕烧进视频 */
  burnIn: boolean
  language: string
  /** 指定模型名，留空用默认 */
  model?: string
}

export interface TranscribeEnvironment {
  pythonFound: boolean
  pythonPath?: string
  pythonVersion?: string
  funasrInstalled: boolean
  modelFound: boolean
  models: string[]
  hint?: string
}

export interface RunningJob {
  id: string
  kind: 'transcribe' | 'convert' | 'merge'
  file: string
  status: JobStatus
  progress: number
  message?: string
  outputFile?: string
  startedAt?: number
  endedAt?: number
  error?: string
}

/* ============================ 配置 ============================ */

export interface EmailConfig {
  enabled: boolean
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  from: string
  to: string[]
}

export interface WebhookConfig {
  enabled: boolean
  url: string
  method: 'POST' | 'GET' | 'PUT'
  headers: Record<string, string>
  bodyTemplate: string
}

export interface WecomConfig {
  enabled: boolean
  webhook: string
}

export interface NotifyConfig {
  onLiveStart: boolean
  onRecordStart: boolean
  onRecordEnd: boolean
  onError: boolean
  onDiskWarning: boolean
  email: EmailConfig
  webhook: WebhookConfig
  wecom: WecomConfig
}

export type DiskAction = 'notify' | 'stop-record' | 'clean-oldest'

export interface DiskConfig {
  enabled: boolean
  minFreeGB: number
  checkIntervalMin: number
  action: DiskAction
  /** clean-oldest 时保留天数 */
  keepDays: number
  /** 监控路径，留空则监控输出目录所在盘 */
  path: string
}

export interface AppConfig {
  /** 录像输出根目录 */
  outputDir: string
  /** 命名模板，支持 {platform} {name} {date} {time} {title} {roomId} {quality} */
  template: string
  /** 分段分钟数，0 = 不分段 */
  segmentMinutes: number
  segmentSizeMB: number
  container: 'mp4' | 'ts' | 'mkv' | 'flv'
  /** 各平台默认清晰度 */
  quality: Record<string, string>

  /** 开播轮询间隔（秒） */
  checkIntervalSec: number
  /** 全局最大同时录制数 */
  maxConcurrent: number
  /** 同一平台最大同时录制数 */
  perPlatformLimit: number
  /** 断流重连次数 */
  retryTimes: number
  reconnectDelaySec: number
  /** 全局开播自动录制开关 */
  autoRecord: boolean

  ffmpegPath: string
  userAgent: string

  saveDanmaku: boolean
  exportAss: boolean
  /** 录制结束自动合并分段 */
  autoMerge: boolean
  /** 录制结束自动转写 */
  autoTranscribe: boolean

  disk: DiskConfig
  notify: NotifyConfig

  theme: 'light' | 'dark' | 'system'
  autoStartup: boolean
  minimizeToTray: boolean
  closeBehavior: 'tray' | 'quit'

  /** 视频号捕获配置 */
  capture: CaptureConfig
  /** 转写配置 */
  transcribe: TranscribeSettings
}

export interface TemplateVariable {
  key: string
  desc: string
  sample: string
}

/* ============================ 凭据 / 系统 / 磁盘 ============================ */

export interface CredentialState {
  platform: PlatformId
  hasCookie: boolean
  updatedAt?: number
  valid?: boolean
  lastCheckedAt?: number
  accountName?: string
  hint?: string
}

export interface FfmpegStatus {
  path: string
  version: string
  source: 'user' | 'bundled' | 'path' | 'none'
}

export interface SystemInfo {
  appVersion: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  portable: boolean
  dataDir: string
  userData: string
  logDir: string
  outputDir: string
  ffmpeg: FfmpegStatus
}

export interface DiskUsage {
  path: string
  totalBytes: number
  freeBytes: number
  usedPercent: number
  recordBytes?: number
  checkedAt: number
  warning: boolean
  error?: string
}

export interface DiskMonitorStatus {
  running: boolean
  lastCheckAt?: number
  nextCheckAt?: number
  lastUsage?: DiskUsage
  warningCount: number
}

/* ============================ 主题 / 通用 ============================ */

export interface ThemeState {
  theme: 'light' | 'dark' | 'system'
  effective: 'light' | 'dark'
}

export interface BatchProgress {
  kind: 'transcribe' | 'convert' | 'merge' | 'import' | 'check' | 'delete'
  total: number
  done: number
  current?: string
  message?: string
  error?: string
}

/** 链接解析结果 */
export interface ParsedLink {
  input: string
  ok: boolean
  platform?: PlatformId
  roomId?: string
  url?: string
  error?: string
  streamer?: Streamer
}

/** 批量添加时的逐项结果 */
export interface AddResult {
  ok: boolean
  added: number
  skipped: number
  failed: number
  items: { input: string; ok: boolean; name?: string; roomId?: string; error?: string }[]
}

export interface UpdateCheckResult {
  current: string
  latest: string
  hasUpdate: boolean
  url?: string
  notes?: string
  error?: string
}
