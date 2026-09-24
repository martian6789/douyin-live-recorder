/**
 * 本地持久化层。全部是纯 JSON，放在数据目录，便于备份与手工修改。
 *
 * 数据目录优先级：
 *   1) 便携版（exe 同级 LiveReview-Data/）—— 拷走 exe 即拷走全部数据
 *   2) Electron userData（%APPDATA%/live-review）
 */
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  AppConfig,
  CredentialState,
  HistoryItem,
  PlatformId,
  Streamer,
  Tag
} from '../shared/types'
import { DEFAULT_UA } from './providers/http'
import { DEFAULT_TEMPLATE, LEGACY_DEFAULT_TEMPLATE } from './template'
import { log } from './logger'

const L = log('store')

let baseDir = ''
let cacheDir: string | null | undefined

/**
 * 「便携」数据目录：数据跟着 exe 走，拷走程序就拷走了全部数据。
 *
 * 两种来源：
 *   1) 单文件便携版 —— NSIS 会注入 PORTABLE_EXECUTABLE_DIR（= exe 所在目录）
 *   2) 解压即用的绿色版 —— 没有环境变量，直接取 exe 所在目录
 * 两种情况都要求该目录可写；不可写（例如放进 Program Files）就退回 userData。
 * 注意排除「exe 在系统临时目录里」的情况 —— 那是便携版解压出来的运行副本，
 * 数据写进去会在退出时被一起清掉。
 */
export function portableDir(): string | null {
  if (cacheDir !== undefined) return cacheDir
  cacheDir = null

  const candidates: string[] = []
  const env = process.env.PORTABLE_EXECUTABLE_DIR
  if (env) candidates.push(env)
  if (app.isPackaged) candidates.push(path.dirname(process.execPath))

  const tmp = os.tmpdir().toLowerCase()
  for (const d of candidates) {
    try {
      // 便携版解压出来的临时运行副本，不能当数据目录
      if (d.toLowerCase().startsWith(tmp)) continue
      fs.mkdirSync(d, { recursive: true })
      fs.accessSync(d, fs.constants.W_OK)
      cacheDir = d
      break
    } catch {
      /* 试下一个 */
    }
  }
  return cacheDir
}

export function portableDataRoot(): string | null {
  const d = portableDir()
  return d ? path.join(d, 'LiveReview-Data') : null
}

export function dataDir(): string {
  if (!baseDir) {
    baseDir = portableDataRoot() ?? app.getPath('userData')
    fs.mkdirSync(baseDir, { recursive: true })
  }
  return baseDir
}

function fileOf(name: string): string {
  return path.join(dataDir(), name)
}

function readJson<T>(name: string, fallback: T): T {
  try {
    const p = fileOf(name)
    if (!fs.existsSync(p)) return fallback
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T
  } catch (e) {
    L.warn('读取失败，使用默认值', name, e)
    return fallback
  }
}

function writeJson(name: string, data: unknown): void {
  const p = fileOf(name)
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, p)
}

/** 深合并默认值：新增配置项后老配置文件也能自动补齐 */
function merge<T extends object>(base: T, patch: Partial<T> | undefined): T {
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base }
  if (!patch) return out
  for (const [k, v] of Object.entries(patch)) {
    const cur = (out as any)[k]
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      cur &&
      typeof cur === 'object' &&
      !Array.isArray(cur)
    ) {
      ;(out as any)[k] = merge(cur, v as any)
    } else if (v !== undefined) {
      ;(out as any)[k] = v
    }
  }
  return out
}

/* ============================ 默认配置 ============================ */

export function defaultOutputDir(): string {
  const portable = portableDataRoot()
  if (portable) {
    const dir = path.join(portable, 'recordings')
    try {
      fs.mkdirSync(dir, { recursive: true })
      return dir
    } catch {
      /* 落到系统视频目录 */
    }
  }
  let videos = app.getPath('videos')
  try {
    fs.mkdirSync(path.join(videos, 'LiveReview'), { recursive: true })
  } catch {
    videos = app.getPath('documents')
  }
  return path.join(videos, 'LiveReview')
}

export function defaultConfig(): AppConfig {
  return {
    outputDir: defaultOutputDir(),
    template: DEFAULT_TEMPLATE,
    segmentMinutes: 0,
    segmentSizeMB: 2048,
    container: 'mp4',
    quality: {
      bilibili: '原画',
      douyu: '原画',
      huya: '原画',
      douyin: '原画',
      kuaishou: '原画'
    },

    checkIntervalSec: 60,
    maxConcurrent: 5,
    perPlatformLimit: 3,
    retryTimes: 3,
    reconnectDelaySec: 5,
    autoRecord: false,

    ffmpegPath: '',
    userAgent: DEFAULT_UA,

    saveDanmaku: true,
    exportAss: true,
    autoMerge: false,
    autoTranscribe: false,

    disk: {
      enabled: false,
      minFreeGB: 10,
      checkIntervalMin: 10,
      action: 'notify',
      keepDays: 7,
      path: ''
    },

    notify: {
      onLiveStart: true,
      onRecordStart: false,
      onRecordEnd: true,
      onError: true,
      onDiskWarning: true,
      email: {
        enabled: false,
        host: '',
        port: 465,
        secure: true,
        user: '',
        pass: '',
        from: '',
        to: []
      },
      webhook: {
        enabled: false,
        url: '',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        bodyTemplate:
          '{"msg":"{event}","streamer":"{name}","platform":"{platform}","title":"{title}","time":"{time}"}'
      },
      wecom: { enabled: false, webhook: '' }
    },

    theme: 'light',
    autoStartup: false,
    minimizeToTray: true,
    closeBehavior: 'tray',

    capture: {
      mode: 'window',
      fps: 30,
      quality: '原画',
      maxMinutes: 0
    },

    transcribe: {
      engine: 'funasr',
      modelRoot: '',
      pythonPath: '',
      runnerPath: '',
      format: 'srt',
      burnIn: false,
      language: 'zh',
      model: ''
    }
  }
}

/* ============================ config ============================ */

export function getConfig(): AppConfig {
  const cfg = merge(defaultConfig(), readJson<Partial<AppConfig>>('config.json', {}))
  // 迁移：旧版默认模板（平台/日期/标题目录）换成「主播名_直播时间」；
  // 用户自己改过的模板不动。
  if (!cfg.template || cfg.template === LEGACY_DEFAULT_TEMPLATE) cfg.template = DEFAULT_TEMPLATE
  return cfg
}

export function setConfig(patch: Partial<AppConfig>): AppConfig {
  const next = merge(getConfig(), patch)
  writeJson('config.json', next)
  return next
}

/** 兼容本项目早期版本的 settings.json */
export function migrateLegacy(): void {
  const p = fileOf('settings.json')
  if (!fs.existsSync(p)) return
  if (fs.existsSync(fileOf('config.json'))) return
  try {
    const old = JSON.parse(fs.readFileSync(p, 'utf8'))
    const patch: Partial<AppConfig> = {}
    if (old.outputDir) patch.outputDir = old.outputDir
    if (old.ffmpegPath) patch.ffmpegPath = old.ffmpegPath
    if (old.segmentMinutes != null) patch.segmentMinutes = old.segmentMinutes
    if (old.retryTimes != null) patch.retryTimes = old.retryTimes
    if (old.saveDanmaku != null) patch.saveDanmaku = old.saveDanmaku
    if (old.exportAss != null) patch.exportAss = old.exportAss
    if (old.userAgent) patch.userAgent = old.userAgent
    if (Object.keys(patch).length) setConfig(patch)
    if (old.cookies && typeof old.cookies === 'object') {
      for (const [k, v] of Object.entries(old.cookies)) {
        if (typeof v === 'string' && v) setCredential(k as PlatformId, v)
      }
    }
    L.info('已从 settings.json 迁移旧配置')
  } catch (e) {
    L.warn('旧配置迁移失败', e)
  }
}

export function resetConfig(): AppConfig {
  const d = defaultConfig()
  writeJson('config.json', d)
  return d
}

/* ============================ streamers ============================ */

export function getStreamers(): Streamer[] {
  const list = readJson<Streamer[]>('streamers.json', [])
  return list.sort((a, b) => {
    if (!!b.top !== !!a.top) return b.top ? 1 : -1
    if (a.order !== b.order) return a.order - b.order
    return a.createdAt - b.createdAt
  })
}

export function setStreamers(list: Streamer[]): void {
  writeJson('streamers.json', list)
}

/* ============================ tags ============================ */

const TAG_COLORS = [
  '#409eff',
  '#67c23a',
  '#e6a23c',
  '#f56c6c',
  '#909399',
  '#9254de',
  '#13c2c2',
  '#eb2f96'
]

export function getTags(): Tag[] {
  return readJson<Tag[]>('tags.json', [])
}

export function setTags(list: Tag[]): void {
  writeJson('tags.json', list)
}

export function pickTagColor(): string {
  const used = new Set(getTags().map((t) => t.color))
  return TAG_COLORS.find((c) => !used.has(c)) ?? TAG_COLORS[getTags().length % TAG_COLORS.length]
}

/* ============================ history ============================ */

export function getHistory(): HistoryItem[] {
  return readJson<HistoryItem[]>('history.json', [])
}

export function setHistory(list: HistoryItem[]): void {
  writeJson('history.json', list.slice(0, 3000))
}

/* ============================ credentials ============================ */

export function getCredentials(): Record<string, CredentialState & { cookie?: string }> {
  return readJson<Record<string, CredentialState & { cookie?: string }>>('credentials.json', {})
}

export function getCookie(platform: PlatformId): string {
  return getCredentials()[platform]?.cookie ?? ''
}

export function setCredential(platform: PlatformId, cookie: string, accountName?: string): void {
  const raw = readJson<Record<string, any>>('credentials.json', {})
  raw[platform] = {
    platform,
    cookie,
    hasCookie: !!cookie,
    updatedAt: Date.now(),
    accountName: accountName ?? raw[platform]?.accountName,
    valid: raw[platform]?.valid,
    lastCheckedAt: raw[platform]?.lastCheckedAt
  }
  writeJson('credentials.json', raw)
}

export function patchCredential(platform: PlatformId, patch: Partial<CredentialState>): void {
  const raw = readJson<Record<string, any>>('credentials.json', {})
  raw[platform] = { ...(raw[platform] ?? { platform, hasCookie: false }), ...patch, platform }
  writeJson('credentials.json', raw)
}

export function clearCredential(platform: PlatformId): void {
  const raw = readJson<Record<string, any>>('credentials.json', {})
  delete raw[platform]
  writeJson('credentials.json', raw)
}

/* ============================ 任务记录（转写/转码/合并） ============================ */

export function getJobs<T>(name: string): T[] {
  return readJson<T[]>(`jobs-${name}.json`, [])
}

export function setJobs<T>(name: string, list: T[]): void {
  writeJson(`jobs-${name}.json`, list.slice(0, 500))
}

/* ============================ 杂项状态 ============================ */

export function readAppState<T extends object>(name: string, fallback: T): T {
  return readJson<T>(`state-${name}.json`, fallback)
}

export function writeAppState(name: string, data: unknown): void {
  writeJson(`state-${name}.json`, data)
}
