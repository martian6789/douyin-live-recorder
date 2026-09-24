/**
 * ffmpeg 相关的一切：定位、探测、录制命令行拼装、转码/合并/转写用的通用执行器。
 *
 * 定位顺序：用户指定 → 打包内置（resources/ffmpeg）→ 系统 PATH。
 * 内置二进制由 electron-builder 的 extraResources 放到 process.resourcesPath/ffmpeg。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import type { FfmpegStatus, QualityPreset, StreamVariant } from '../shared/types'
import { getConfig } from './store'
import { log } from './logger'

const L = log('ffmpeg')

/** 启动时首次成功探测到的 ffmpeg 路径，后续录制直接复用，避免便携版
 *  临时目录在运行期间被清理或路径解析波动导致“找不到”。 */
let cachedFfmpeg: FfmpegStatus | null = null

export type ToolName = 'ffmpeg.exe' | 'ffprobe.exe' | 'ffplay.exe'

/** 内置二进制所在目录（打包后 / 开发时都覆盖） */
function bundledDirs(): string[] {
  const list: string[] = []
  try {
    list.push(path.join(process.resourcesPath || '', 'ffmpeg'))
    list.push(process.resourcesPath || '')
  } catch {
    /* ignore */
  }
  try {
    list.push(path.join(app.getAppPath(), 'resources'))
  } catch {
    /* ignore */
  }
  list.push(path.join(__dirname, '../../resources'))
  return list.filter(Boolean)
}

export function bundledTool(name: ToolName): string | null {
  for (const d of bundledDirs()) {
    const p = path.join(d, name)
    if (fs.existsSync(p)) return p
  }
  return null
}

function versionOf(exe: string): string | null {
  try {
    const out = execFileSync(exe, ['-version'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 1 << 20
    })
    const m = /(?:ffmpeg|ffprobe) version (\S+)/.exec(out)
    return m ? m[1] : out.split('\n')[0].slice(0, 60)
  } catch {
    return null
  }
}

export function detectFfmpeg(): FfmpegStatus {
  if (cachedFfmpeg && cachedFfmpeg.source !== 'none' && fs.existsSync(cachedFfmpeg.path)) {
    return cachedFfmpeg
  }

  const candidates: { path: string; source: FfmpegStatus['source'] }[] = []

  const user = getConfig().ffmpegPath
  if (user) candidates.push({ path: user, source: 'user' })

  const bundled = bundledTool('ffmpeg.exe')
  if (bundled) candidates.push({ path: bundled, source: 'bundled' })

  try {
    const which = execFileSync('where', ['ffmpeg'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true
    })
    which
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && fs.existsSync(l))
      .forEach((l) => candidates.push({ path: l, source: 'path' }))
  } catch {
    /* 系统里没有 */
  }

  for (const c of candidates) {
    if (!fs.existsSync(c.path)) {
      L.debug('ffmpeg 候选不存在', c.path)
      continue
    }
    const v = versionOf(c.path)
    if (v) {
      cachedFfmpeg = { path: c.path, version: v, source: c.source }
      L.info('ffmpeg 已定位', `${c.source}=${c.path} version=${v}`)
      return cachedFfmpeg
    }
    L.warn('ffmpeg 候选无法执行', c.path)
  }

  L.warn('ffmpeg 未找到', {
    user: getConfig().ffmpegPath,
    bundled,
    resourcesPath: process.resourcesPath,
    appPath: (() => { try { return app.getAppPath() } catch { return '' } })()
  })
  return { path: '', version: '', source: 'none' }
}

export function requireFfmpeg(): string {
  const st = detectFfmpeg()
  if (st.source === 'none') throw new Error('未找到 ffmpeg，请在「设置」里指定 ffmpeg.exe 路径')
  return st.path
}

/**
 * ffprobe 是可选的：内置不再附带（一个 ffprobe.exe 就 100 MB，而它提供的
 * 时长/分辨率信息 ffmpeg 自己 `-i` 就能打印）。有就用，没有就走 ffmpeg 兜底：
 * 内置目录 → 与 ffmpeg 同目录 → 系统 PATH。
 */
export function ffprobePath(): string | null {
  const b = bundledTool('ffprobe.exe')
  if (b) return b
  const ff = detectFfmpeg()
  if (ff.path) {
    const sib = path.join(path.dirname(ff.path), 'ffprobe.exe')
    if (fs.existsSync(sib)) return sib
  }
  try {
    const which = execFileSync('where', ['ffprobe'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true
    })
    const first = which
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && fs.existsSync(l))
    if (first) return first
  } catch {
    /* 系统里没有 */
  }
  return null
}

export function ffplayPath(): string | null {
  return bundledTool('ffplay.exe')
}

/* ============================ 执行器 ============================ */

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export function run(exe: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 16 << 20 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}

/** 启动一个长跑进程并返回句柄。stdout 用于读 -progress，stdin 用于写 q 优雅结束 */
export function spawnFfmpeg(args: string[]): ChildProcess {
  const exe = requireFfmpeg()
  L.info('spawn', exe, args.join(' '))
  return spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
}

/* ============================ 探测 ============================ */

/**
 * 用 `ffmpeg -i <file>`（不带输出）拿到媒体信息文本。
 * ffmpeg 把这类信息全打在 stderr 上，并以退出码 1 收场，属正常现象。
 */
async function ffmpegInfoText(file: string): Promise<string> {
  const exe = detectFfmpeg().path
  if (!exe) return ''
  const r = await run(exe, ['-hide_banner', '-nostdin', '-i', file], 30_000)
  return `${r.stderr}\n${r.stdout}`
}

function parseDurationMs(text: string): number | null {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text)
  if (!m) return null
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3])
  if (!Number.isFinite(sec) || sec <= 0) return null
  return Math.round(sec * 1000)
}

export async function probeDuration(file: string): Promise<number | null> {
  const probe = ffprobePath()
  if (probe) {
    const r = await run(probe, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      file
    ])
    const n = parseFloat((r.stdout || '').trim())
    if (Number.isFinite(n) && n > 0) return Math.round(n * 1000)
  }
  // 兜底：ffmpeg 自己就能报时长
  return parseDurationMs(await ffmpegInfoText(file))
}

export interface MediaInfo {
  durationMs?: number
  width?: number
  height?: number
  fps?: number
  vcodec?: string
  acodec?: string
  sizeBytes?: number
}

export async function probeMedia(file: string): Promise<MediaInfo> {
  const probe = ffprobePath()
  if (probe) {
    const r = await run(
      probe,
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
      30_000
    )
    try {
      const j = JSON.parse(r.stdout)
      const v = (j.streams ?? []).find((s: any) => s.codec_type === 'video')
      const a = (j.streams ?? []).find((s: any) => s.codec_type === 'audio')
      return {
        durationMs: j.format?.duration
          ? Math.round(parseFloat(j.format.duration) * 1000)
          : undefined,
        width: v?.width,
        height: v?.height,
        fps: v?.avg_frame_rate ? evalFps(v.avg_frame_rate) : undefined,
        vcodec: v?.codec_name,
        acodec: a?.codec_name,
        sizeBytes: j.format?.size ? parseInt(j.format.size, 10) : undefined
      }
    } catch {
      /* 落到下面的 ffmpeg 兜底 */
    }
  }
  return parseMediaText(await ffmpegInfoText(file), file)
}

/**
 * 解析 `ffmpeg -i` 的输出。样例：
 *   Duration: 00:12:34.56, start: 0.000000, bitrate: 2500 kb/s
 *   Stream #0:0: Video: h264 (High), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 60 fps, ...
 *   Stream #0:1: Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s
 */
function parseMediaText(text: string, file: string): MediaInfo {
  if (!text) return {}
  const info: MediaInfo = {}

  const dur = parseDurationMs(text)
  if (dur) info.durationMs = dur

  const vLine = text.split(/\r?\n/).find((l) => /Stream #\S+.*:\s*Video:/.test(l))
  if (vLine) {
    info.vcodec = /Video:\s*([A-Za-z0-9_]+)/.exec(vLine)?.[1]
    const dim = /(\d{2,5})x(\d{2,5})/.exec(vLine)
    if (dim) {
      info.width = Number(dim[1])
      info.height = Number(dim[2])
    }
    const fps = /([\d.]+)\s*(?:fps|tbr)/.exec(vLine)
    if (fps) {
      const n = parseFloat(fps[1])
      if (Number.isFinite(n) && n > 0) info.fps = n
    }
  }

  const aLine = text.split(/\r?\n/).find((l) => /Stream #\S+.*:\s*Audio:/.test(l))
  if (aLine) info.acodec = /Audio:\s*([A-Za-z0-9_]+)/.exec(aLine)?.[1]

  try {
    info.sizeBytes = fs.statSync(file).size
  } catch {
    /* 文件不在了就算了 */
  }

  return info
}

function evalFps(s: string): number | undefined {
  const [a, b] = s.split('/').map(Number)
  if (!b) return a || undefined
  return a / b
}

/** 列出 DirectShow 音频设备（视频号捕获时录系统声音用） */
export async function listAudioDevices(): Promise<string[]> {
  const exe = detectFfmpeg().path
  if (!exe) return []
  const r = await run(
    exe,
    ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
    15_000
  )
  const text = r.stderr + r.stdout
  const out: string[] = []
  let inAudio = false
  for (const line of text.split(/\r?\n/)) {
    if (/DirectShow audio devices/i.test(line)) {
      inAudio = true
      continue
    }
    if (/DirectShow video devices/i.test(line)) {
      inAudio = false
      continue
    }
    if (!inAudio) continue
    if (/Alternative name/i.test(line)) continue
    const m = /"([^"]+)"/.exec(line)
    if (m) out.push(m[1])
  }
  return [...new Set(out)]
}

/* ============================ 录制命令 ============================ */

export interface RecordArgsOptions {
  url: string
  output: string
  variant: StreamVariant
  userAgent?: string
  segmentMinutes?: number
  container?: 'mp4' | 'ts' | 'mkv' | 'flv'
}

function commonFlags(): string[] {
  return ['-hide_banner', '-loglevel', 'warning', '-nostdin']
}

/** 输入前的 HTTP 参数（UA / Referer / Origin / Cookie / 自动重连） */
function inputFlags(variant: StreamVariant, userAgent?: string): string[] {
  const args: string[] = [
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '10'
  ]
  const ua = variant.headers?.['User-Agent'] || userAgent
  if (ua) args.push('-user_agent', ua)
  // 关键：ffmpeg 的 `-headers` 是「单个选项」，重复传会互相覆盖（最后一个才生效）。
  // 所以 Referer / Origin / Cookie 必须拼成一段 CRLF 分隔的字符串一次性传进去。
  const headerLines: string[] = []
  const ref = variant.headers?.['Referer']
  if (ref) headerLines.push(`Referer: ${ref}`)
  const origin = variant.headers?.['Origin']
  if (origin) headerLines.push(`Origin: ${origin}`)
  const cookie = variant.headers?.['Cookie']
  if (cookie) headerLines.push(`Cookie: ${cookie}`)
  if (headerLines.length) args.push('-headers', headerLines.join('\r\n') + '\r\n')
  return args
}

/** 实时转码预览：把 HEVC/H.265 等浏览器不支持的直播流转成 H.264 FLV，经本地中继播放 */
export function buildPreviewTranscodeArgs(o: {
  url: string
  variant: StreamVariant
  userAgent?: string
  maxHeight?: number
}): string[] {
  const args = [
    ...commonFlags(),
    '-fflags',
    '+discardcorrupt',
    ...inputFlags(o.variant, o.userAgent),
    '-i',
    o.url
  ]
  const h = o.maxHeight && o.maxHeight > 0 ? o.maxHeight : 720
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-crf',
    '30',
    '-pix_fmt',
    'yuv420p',
    '-vf',
    `scale=-2:${h}`,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '44100',
    '-threads',
    '2',
    '-max_muxing_queue_size',
    '1024',
    '-f',
    'flv',
    'pipe:1'
  )
  return args
}

function containerFlags(container: 'mp4' | 'ts' | 'mkv' | 'flv'): string[] {
  if (container === 'mp4') {
    // frag_keyframe + empty_moov：进程被强杀也能播放
    return ['-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof']
  }
  if (container === 'flv') return ['-f', 'flv']
  if (container === 'mkv') return ['-f', 'matroska']
  return ['-f', 'mpegts']
}

/** 构造直播录制参数。多分段时用 segment muxer，输出名需带 %03d */
export function buildRecordArgs(o: RecordArgsOptions): string[] {
  const container = o.container ?? 'mp4'
  const args = [...commonFlags(), ...inputFlags(o.variant, o.userAgent), '-i', o.url, '-c', 'copy']

  if (container === 'mp4' || container === 'mkv') args.push('-bsf:a', 'aac_adtstoasc')

  if (o.segmentMinutes && o.segmentMinutes > 0) {
    args.push(
      '-f',
      'segment',
      '-segment_time',
      String(o.segmentMinutes * 60),
      '-reset_timestamps',
      '1',
      '-segment_format',
      container,
      '-segment_list',
      o.output.replace(/\.[^.]+$/, '.csv'),
      '-segment_list_type',
      'csv'
    )
    if (container === 'mp4') {
      args.push(
        '-segment_format_options',
        'movflags=+frag_keyframe+empty_moov+default_base_moof'
      )
    }
  } else {
    args.push(...containerFlags(container))
  }

  args.push('-y', o.output)
  return args
}

/* ============================ 捕获命令（视频号） ============================ */

export interface CaptureArgsOptions {
  mode: 'screen' | 'window'
  sourceName?: string
  fps: number
  audioDevice?: string
  output: string
  crop?: { x: number; y: number; w: number; h: number }
  quality: QualityPreset
  segmentMinutes?: number
  drawMouse?: boolean
}

const CRF_BY_QUALITY: Record<string, string> = {
  原画: '18',
  蓝光: '20',
  超清: '22',
  高清: '24',
  标清: '28',
  流畅: '32'
}

export function buildCaptureArgs(o: CaptureArgsOptions): string[] {
  const args = [...commonFlags()]

  args.push('-f', 'gdigrab', '-framerate', String(o.fps))
  if (o.mode === 'screen') {
    if (o.crop && o.crop.w > 0 && o.crop.h > 0) {
      args.push(
        '-offset_x',
        String(o.crop.x),
        '-offset_y',
        String(o.crop.y),
        '-video_size',
        `${o.crop.w}x${o.crop.h}`
      )
    }
    args.push('-i', 'desktop')
  } else {
    if (!o.sourceName) throw new Error('窗口模式下必须指定窗口标题')
    args.push('-i', `title=${o.sourceName}`)
  }

  if (o.drawMouse === false) args.push('-draw_mouse', '0')

  if (o.audioDevice) args.push('-f', 'dshow', '-i', `audio=${o.audioDevice}`)

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    CRF_BY_QUALITY[o.quality] ?? '22',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(Math.max(30, o.fps * 2))
  )
  if (o.audioDevice) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000')

  if (o.segmentMinutes && o.segmentMinutes > 0) {
    args.push(
      '-f',
      'segment',
      '-segment_time',
      String(o.segmentMinutes * 60),
      '-reset_timestamps',
      '1',
      '-segment_format',
      'mp4',
      '-segment_format_options',
      'movflags=+frag_keyframe+empty_moov+default_base_moof'
    )
  } else {
    args.push(
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4'
    )
  }

  args.push('-y', o.output)
  return args
}

/* ============================ 转码 / 合并 / 音频抽取 ============================ */

export function buildConvertArgs(
  input: string,
  output: string,
  container: 'mp4' | 'ts' | 'mkv' | 'flv'
): string[] {
  const args = [...commonFlags(), '-i', input, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k']
  args.push(...containerFlags(container))
  args.push('-y', output)
  return args
}

export function buildConcatListArgs(listFile: string, output: string): string[] {
  return [...commonFlags(), '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', output]
}

export function buildConcatProtocolArgs(inputs: string[], output: string): string[] {
  const joined = inputs.map((p) => p.replace(/\\/g, '/')).join('|')
  return [...commonFlags(), '-i', `concat:${joined}`, '-c', 'copy', '-y', output]
}

export function buildExtractAudioArgs(input: string, output: string): string[] {
  return [
    ...commonFlags(),
    '-i',
    input,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-y',
    output
  ]
}

export function buildBurnSubtitleArgs(input: string, subFile: string, output: string): string[] {
  return [
    ...commonFlags(),
    '-i',
    input,
    '-vf',
    `subtitles='${subFile.replace(/\\/g, '/').replace(/:/g, '\\:')}'`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '22',
    '-c:a',
    'copy',
    '-y',
    output
  ]
}

export function ffmpegStatus(): FfmpegStatus {
  return detectFfmpeg()
}
