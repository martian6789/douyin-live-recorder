/**
 * 视频号录制（捕获模式）。
 *
 * 原版这里走的是「自签根证书 + 接管系统代理」的 MITM 方案，能直接解密出直播流地址，
 * 但代价是整台机器的 HTTPS 都在它眼皮底下（含网银），本项目**不采用**。
 * 改用等价效果的合规做法：屏幕/窗口捕获 + 系统音频回环，用 ffmpeg 的 gdigrab + dshow 录制。
 *
 * 效果：视频号直播照样能录，画质取决于窗口大小；不碰证书、不动代理、不改 hosts。
 */
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type { CaptureConfig, CaptureSource, CaptureStatus, QualityPreset } from '../shared/types'
import { getConfig, setConfig } from './store'
import { buildCaptureArgs, detectFfmpeg, listAudioDevices, spawnFfmpeg } from './ffmpeg'
import { renderTemplate } from './template'
import { log } from './logger'

const L = log('capture')

export const capture = new EventEmitter()
capture.setMaxListeners(0)

let proc: ChildProcess | null = null
let timer: NodeJS.Timeout | null = null
let currentOut = ''
let startedAt = 0
let lastError: string | undefined
let limitTimer: NodeJS.Timeout | null = null

export function getConfigOf(): CaptureConfig {
  return getConfig().capture
}

export function setCaptureConfig(patch: Partial<CaptureConfig>): CaptureConfig {
  const next = setConfig({ capture: { ...getConfigOf(), ...patch } }).capture
  capture.emit('status', status())
  return next
}

/** 列出可捕获的窗口与屏幕（缩略图供界面预览） */
export async function listSources(withThumbnail = true): Promise<CaptureSource[]> {
  const { desktopCapturer } = await import('electron')
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: withThumbnail ? { width: 320, height: 180 } : { width: 0, height: 0 },
    fetchWindowIcons: false
  })

  const out: CaptureSource[] = []
  for (const s of sources) {
    const isScreen = s.id.startsWith('screen')
    out.push({
      id: s.id,
      name: s.name || (isScreen ? '整个屏幕' : '未命名窗口'),
      mode: isScreen ? 'screen' : 'window',
      thumbnail: withThumbnail ? s.thumbnail?.isEmpty() ? undefined : s.thumbnail.toDataURL() : undefined
    })
  }
  // 屏幕在前
  return out.sort((a, b) => (a.mode === b.mode ? a.name.localeCompare(b.name) : a.mode === 'screen' ? -1 : 1))
}

export async function audioDevices(): Promise<string[]> {
  try {
    return await listAudioDevices()
  } catch {
    return []
  }
}

export function isRecording(): boolean {
  return !!proc && proc.exitCode == null
}

export function status(): CaptureStatus {
  const cfg = getConfigOf()
  const ff = detectFfmpeg()
  return {
    ready: ff.source !== 'none',
    ffmpeg: ff,
    sources: [],
    audioDevices: [],
    config: cfg,
    recording: isRecording(),
    taskId: currentOut || undefined,
    error: lastError
  }
}

/* ============================ 录制 ============================ */

function computeOutput(cfg: CaptureConfig): string {
  const root = cfg.saveDir || getConfig().outputDir
  const rel = renderTemplate(getConfig().template, {
    platform: 'hudi',
    platformName: '微信视频号',
    name: cfg.name || '视频号捕获',
    roomId: cfg.sourceName || 'capture',
    title: cfg.sourceName || '窗口捕获',
    quality: cfg.quality
  })
  const base = path.isAbsolute(rel) ? rel : path.join(root, rel)
  fs.mkdirSync(path.dirname(base), { recursive: true })
  const ext = 'mp4'
  return fs.existsSync(`${base}.${ext}`) ? `${base}.${ext}` : `${base}.${ext}`
}

export interface StartCaptureResult {
  ok: boolean
  file?: string
  error?: string
}

export function startCapture(override?: Partial<CaptureConfig>): StartCaptureResult {
  if (isRecording()) return { ok: false, error: '已有捕获任务在运行' }

  const cfg = { ...getConfigOf(), ...(override ?? {}) }
  setCaptureConfig(override ?? {})

  const ff = detectFfmpeg()
  if (ff.source === 'none') return { ok: false, error: '未找到 ffmpeg，请先在「设置」里指定路径' }

  if (cfg.mode === 'window' && !cfg.sourceName) {
    return { ok: false, error: '请先选择一个窗口' }
  }

  let output: string
  try {
    output = computeOutput(cfg)
  } catch (e: any) {
    return { ok: false, error: `输出路径无效：${e?.message ?? e}` }
  }

  const args = buildCaptureArgs({
    mode: cfg.mode,
    sourceName: cfg.sourceName,
    fps: cfg.fps,
    audioDevice: cfg.audioDevice || undefined,
    output,
    crop: cfg.crop,
    quality: cfg.quality as QualityPreset,
    segmentMinutes: getConfig().segmentMinutes
  })

  try {
    proc = spawnFfmpeg(args)
  } catch (e: any) {
    lastError = e?.message ?? String(e)
    capture.emit('status', status())
    return { ok: false, error: lastError }
  }

  currentOut = output
  startedAt = Date.now()
  lastError = undefined

  proc.on('error', (e) => {
    lastError = e.message
    L.error('捕获进程错误', e)
    capture.emit('status', status())
  })
  proc.on('exit', (code) => {
    L.info('捕获结束', code, output)
    cleanup()
    if (code !== 0 && code != null) {
      lastError = `ffmpeg 退出码 ${code}`
      capture.emit('error', lastError)
    }
    let size = 0
    try {
      size = fs.statSync(output).size
    } catch {
      /* ignore */
    }
    capture.emit('ended', { file: output, size, durationMs: Date.now() - startedAt })
    capture.emit('status', status())
  })

  // 兜底：读一下 stdout 让进程保持被消费（避免管道塞住）
  proc.stdout?.on('data', () => void 0)
  proc.stderr?.on('data', (b: Buffer) => {
    const text = b.toString('utf8')
    if (/error|Error|Invalid|failed/i.test(text)) lastError = text.slice(-300)
  })

  if (cfg.maxMinutes > 0) {
    limitTimer = setTimeout(
      () => {
        L.info('捕获达到时长上限，自动停止')
        stopCapture()
      },
      cfg.maxMinutes * 60_000
    )
  }

  capture.emit('started', output)
  capture.emit('status', status())
  return { ok: true, file: output }
}

export function stopCapture(): void {
  if (!proc || proc.exitCode != null) {
    cleanup()
    return
  }
  try {
    proc.stdin?.write('q')
    proc.stdin?.end()
  } catch {
    /* ignore */
  }
  const p = proc
  setTimeout(() => {
    if (p.exitCode == null) {
      L.warn('捕获进程未响应 q，强制结束')
      try {
        p.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }, 6000)
}

function cleanup(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (limitTimer) {
    clearTimeout(limitTimer)
    limitTimer = null
  }
  proc = null
}
