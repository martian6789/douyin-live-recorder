/**
 * 本地语音转写（FunASR / Paraformer）。
 *
 * 思路和原版一致：不把音频传到云端，用本机 Python + 本地模型跑。
 * 因此第一步是「环境体检」——python 有没有、funasr 装没装、模型下没下，
 * 界面按体检结果给出可点击的修复动作。
 *
 * 流程：视频 →(ffmpeg 抽 16k 单声道 wav)→ python runner →(srt/txt/json)
 * 可选把 srt 烧进视频，或用 ASS 弹幕叠加。
 */
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import type {
  RunningJob,
  TranscribeEnvironment,
  TranscribeSettings
} from '../shared/types'
import { app } from 'electron'
import { getConfig, setConfig, setJobs, getJobs } from './store'
import {
  buildBurnSubtitleArgs,
  buildExtractAudioArgs,
  probeDuration,
  requireFfmpeg,
  run
} from './ffmpeg'
import { listVideos } from './merger'
import { log } from './logger'

const L = log('transcribe')

export const transcribe = new EventEmitter()
transcribe.setMaxListeners(0)

let current: ChildProcess | null = null
let cancelled = false

/* ============================ 路径 ============================ */

function resourcesDir(): string {
  const candidates = [
    path.join(process.resourcesPath || '', 'ffmpeg', '..'), // resources/
    process.resourcesPath || '',
    path.join(app.getAppPath(), 'resources'),
    path.join(__dirname, '../../resources')
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'funasr_runner.py'))) return path.resolve(c)
  }
  return path.join(app.getAppPath(), 'resources')
}

export function runnerScript(): string {
  const s = getConfig().transcribe
  if (s.runnerPath && fs.existsSync(s.runnerPath)) return s.runnerPath
  const builtin = path.join(resourcesDir(), 'funasr_runner.py')
  return builtin
}

function downloadScript(): string {
  return path.join(resourcesDir(), 'funasr_download_models.py')
}

/* ============================ 环境体检 ============================ */

function pythonCandidates(): string[] {
  const s = getConfig().transcribe
  const list: string[] = []
  if (s.pythonPath) list.push(s.pythonPath)
  const home = process.env.USERPROFILE || ''
  list.push(
    path.join(home, 'anaconda3', 'python.exe'),
    path.join(home, 'miniconda3', 'python.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'),
    'C:\\Python312\\python.exe',
    'C:\\Python311\\python.exe',
    'python'
  )
  return list.filter(Boolean)
}

function tryPython(exe: string): { ok: boolean; version?: string } {
  try {
    const out = execFileSync(exe, ['-c', 'import sys;print(sys.version.split()[0])'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true
    }).trim()
    return { ok: true, version: out }
  } catch {
    return { ok: false }
  }
}

function hasFunasr(exe: string): boolean {
  try {
    execFileSync(exe, ['-c', 'import funasr;print(funasr.__version__)'], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true
    })
    return true
  } catch {
    return false
  }
}

export async function checkEnvironment(): Promise<TranscribeEnvironment> {
  const s = getConfig().transcribe
  const env: TranscribeEnvironment = {
    pythonFound: false,
    funasrInstalled: false,
    modelFound: false,
    models: []
  }

  for (const exe of pythonCandidates()) {
    const r = tryPython(exe)
    if (r.ok) {
      env.pythonFound = true
      env.pythonPath = exe
      env.pythonVersion = r.version
      env.funasrInstalled = hasFunasr(exe)
      break
    }
  }

  env.models = listModels()
  env.modelFound = env.models.length > 0

  if (!env.pythonFound) {
    env.hint = '未检测到 Python。请先安装 Python 3.10+，或在下方手动指定 python.exe 路径。'
  } else if (!env.funasrInstalled) {
    env.hint = '检测到 Python，但未安装 funasr。点「安装本地依赖」会自动 pip install funasr modelscope。'
  } else if (!env.modelFound) {
    env.hint = `未找到本地模型。点「下载本地模型」会下载 Paraformer 中文模型${s.modelRoot ? '' : '（建议先设置模型根目录）'}。`
  } else {
    env.hint = `环境就绪：Python ${env.pythonVersion}，已发现 ${env.models.length} 个模型。`
  }
  return env
}

/** 扫描模型根目录，识别常见 FunASR 模型文件夹 */
export function listModels(): string[] {
  const roots = modelRoots()
  const out: string[] = []
  for (const root of roots) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const p = path.join(root, e.name)
      const looksLikeModel = ['configuration.json', 'config.yaml', 'model.pt', 'model.ckpt'].some(
        (f) => fs.existsSync(path.join(p, f))
      )
      if (looksLikeModel) out.push(p)
      else {
        // 再下一层（ModelScope 的 iic/xxx 结构）
        try {
          for (const sub of fs.readdirSync(p, { withFileTypes: true })) {
            if (!sub.isDirectory()) continue
            const sp = path.join(p, sub.name)
            if (
              ['configuration.json', 'config.yaml', 'model.pt', 'model.ckpt'].some((f) =>
                fs.existsSync(path.join(sp, f))
              )
            ) {
              out.push(sp)
            }
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  return [...new Set(out)]
}

function modelRoots(): string[] {
  const s = getConfig().transcribe
  const roots: string[] = []
  if (s.modelRoot) roots.push(s.modelRoot)
  roots.push(path.join(app.getPath('userData'), 'models'))
  if (process.env.MODELSCOPE_CACHE) roots.push(process.env.MODELSCOPE_CACHE)
  const home = process.env.USERPROFILE || ''
  roots.push(path.join(home, '.cache', 'modelscope', 'hub'))
  return roots.filter(Boolean)
}

/* ============================ 设置 ============================ */

export function getSettings(): TranscribeSettings {
  return getConfig().transcribe
}

export function saveSettings(patch: Partial<TranscribeSettings>): TranscribeSettings {
  const next = { ...getConfig().transcribe, ...patch }
  setConfig({ transcribe: next })
  return next
}

/* ============================ 扫描 ============================ */

export interface TranscribeItem {
  file: string
  name: string
  dir: string
  sizeBytes: number
  durationMs?: number
  /** 已有转写产物 */
  existing?: string
}

export async function scanFiles(dir: string, recursive = true): Promise<TranscribeItem[]> {
  const files = listVideos(dir, recursive)
  const out: TranscribeItem[] = []
  for (const f of files) {
    const base = f.replace(/\.[^.]+$/, '')
    const existing = ['.srt', '.txt', '.vtt', '.json'].map((e) => base + e).find((p) => fs.existsSync(p))
    let size = 0
    try {
      size = fs.statSync(f).size
    } catch {
      continue
    }
    out.push({
      file: f,
      name: path.basename(f),
      dir: path.dirname(f),
      sizeBytes: size,
      existing
    })
  }
  return out.sort((a, b) => b.sizeBytes - a.sizeBytes)
}

/* ============================ 依赖安装 / 模型下载 ============================ */

export function installDependencies(pythonPath?: string): void {
  const env = pythonPath || getConfig().transcribe.pythonPath
  if (!env) {
    transcribe.emit('local-install', { status: 'error', message: '未找到 Python，请先指定 python.exe' })
    return
  }
  const args = ['-m', 'pip', 'install', '-U', 'funasr', 'modelscope', '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple']
  L.info('安装 funasr', env, args.join(' '))
  const p = spawn(env, args, { windowsHide: true })
  let buf = ''
  const push = (t: string): void => {
    buf = (buf + t).slice(-4000)
    transcribe.emit('local-install', { status: 'running', message: t.trim().slice(-200) })
  }
  p.stdout?.on('data', (b: Buffer) => push(b.toString('utf8')))
  p.stderr?.on('data', (b: Buffer) => push(b.toString('utf8')))
  p.on('exit', (code) => {
    transcribe.emit('local-install', {
      status: code === 0 ? 'done' : 'error',
      message: code === 0 ? '依赖安装完成' : `pip 退出码 ${code}：${buf.split('\n').filter(Boolean).slice(-2).join(' ')}`
    })
  })
}

export function downloadModels(pythonPath?: string): void {
  const py = pythonPath || getConfig().transcribe.pythonPath
  if (!py) {
    transcribe.emit('local-install', { status: 'error', message: '未找到 Python' })
    return
  }
  const script = downloadScript()
  if (!fs.existsSync(script)) {
    transcribe.emit('local-install', { status: 'error', message: `缺少脚本：${script}` })
    return
  }
  const modelRoot = getConfig().transcribe.modelRoot || path.join(app.getPath('userData'), 'models')
  fs.mkdirSync(modelRoot, { recursive: true })
  const p = spawn(py, [script, modelRoot], { windowsHide: true })
  let buf = ''
  const push = (t: string): void => {
    buf = (buf + t).slice(-4000)
    transcribe.emit('local-install', { status: 'running', message: t.trim().slice(-200) })
  }
  p.stdout?.on('data', (b: Buffer) => push(b.toString('utf8')))
  p.stderr?.on('data', (b: Buffer) => push(b.toString('utf8')))
  p.on('exit', (code) => {
    transcribe.emit('local-install', {
      status: code === 0 ? 'done' : 'error',
      message: code === 0 ? `模型已下载到 ${modelRoot}` : `脚本退出码 ${code}`
    })
  })
}

/* ============================ 转写 ============================ */

export function isRunning(): boolean {
  return current != null
}

export function stop(): void {
  cancelled = true
  if (current && current.exitCode == null) {
    try {
      current.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    transcribe.emit('progress', { kind: 'transcribe', total: 0, done: 0, message: '已取消' })
  }
  current = null
}

async function transcribeOne(item: TranscribeItem): Promise<RunningJob> {
  const s = getConfig().transcribe
  const job: RunningJob = {
    id: `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind: 'transcribe',
    file: item.file,
    status: 'running',
    progress: 0,
    message: '抽取音频…',
    startedAt: Date.now()
  }
  transcribe.emit('progress', job)

  const base = item.file.replace(/\.[^.]+$/, '')
  const wav = `${base}.16k.wav`

  try {
    // 1) 抽音频
    const ex = await run(requireFfmpeg(), buildExtractAudioArgs(item.file, wav), 3600_000)
    if (ex.code !== 0 || !fs.existsSync(wav)) {
      throw new Error('抽取音频失败：' + ex.stderr.slice(-200))
    }
    if (cancelled) throw new Error('已取消')

    job.progress = 15
    job.message = '识别中（本地模型，耗时取决于 CPU）…'
    transcribe.emit('progress', job)

    // 2) 跑 runner
    const py = s.pythonPath || (await checkEnvironment()).pythonPath
    if (!py) throw new Error('未找到 Python，请先做环境体检')
    const runner = runnerScript()
    if (!fs.existsSync(runner)) throw new Error(`缺少转写脚本：${runner}`)

    const args = [
      runner,
      '--input',
      wav,
      '--output',
      base,
      '--format',
      s.format,
      '--language',
      s.language
    ]
    if (s.model) args.push('--model', s.model)
    if (s.modelRoot) args.push('--model-root', s.modelRoot)

    const r = await runWithStream(py, args, (line) => {
      const m = /(\d{1,3})%/.exec(line)
      if (m) {
        job.progress = Math.max(15, Math.min(95, Number(m[1])))
        job.message = line.trim().slice(0, 160)
        transcribe.emit('progress', job)
      } else if (line.trim()) {
        job.message = line.trim().slice(0, 160)
        transcribe.emit('progress', job)
      }
    })

    if (r !== 0) throw new Error(`转写脚本退出码 ${r}`)

    const outFile = `${base}.${s.format === 'json' ? 'json' : s.format}`
    if (!fs.existsSync(outFile)) {
      // 有些实现输出 .txt（json 失败时）
      const alt = `${base}.txt`
      if (fs.existsSync(alt)) {
        job.outputFile = alt
      } else {
        throw new Error('脚本执行完成但没有产出字幕文件')
      }
    } else {
      job.outputFile = outFile
    }

    // 3) 可选烧字幕
    if (s.burnIn && job.outputFile && job.outputFile.endsWith('.srt')) {
      job.message = '烧录字幕到视频…'
      job.progress = 96
      transcribe.emit('progress', job)
      const burned = `${base}.sub.mp4`
      const b = await run(requireFfmpeg(), buildBurnSubtitleArgs(item.file, job.outputFile, burned), 12 * 3600_000)
      if (b.code === 0 && fs.existsSync(burned)) job.outputFile = burned
    }

    job.progress = 100
    job.status = 'done'
    job.endedAt = Date.now()
  } catch (e: any) {
    job.status = 'error'
    job.error = e?.message ?? String(e)
    job.endedAt = Date.now()
  } finally {
    try {
      if (fs.existsSync(wav)) fs.unlinkSync(wav)
    } catch {
      /* ignore */
    }
    transcribe.emit('progress', job)
  }
  return job
}

function runWithStream(exe: string, args: string[], onLine: (l: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(exe, args, { windowsHide: true })
    current = p
    const feed = (b: Buffer): void => {
      for (const l of b.toString('utf8').split(/\r?\n/)) if (l) onLine(l)
    }
    p.stdout?.on('data', feed)
    p.stderr?.on('data', feed)
    p.on('error', () => resolve(1))
    p.on('exit', (code) => {
      current = null
      resolve(code ?? 0)
    })
  })
}

export async function startBatch(items: TranscribeItem[]): Promise<RunningJob[]> {
  cancelled = false
  const jobs: RunningJob[] = []
  for (let i = 0; i < items.length; i++) {
    if (cancelled) break
    transcribe.emit('batch-progress', {
      kind: 'transcribe',
      total: items.length,
      done: i,
      current: items[i].name
    } as any)
    jobs.push(await transcribeOne(items[i]))
  }
  setJobs('transcribe', [...jobs, ...getJobs<RunningJob>('transcribe')])
  transcribe.emit('batch-progress', {
    kind: 'transcribe',
    total: items.length,
    done: jobs.length,
    message: '全部完成'
  } as any)
  return jobs
}

/** 删除某视频对应的转写产物 */
export function deleteOutputs(file: string): string[] {
  const base = file.replace(/\.[^.]+$/, '')
  const removed: string[] = []
  for (const ext of ['.srt', '.txt', '.vtt', '.json', '.16k.wav', '.sub.mp4']) {
    const p = base + ext
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p)
        removed.push(p)
      } catch {
        /* ignore */
      }
    }
  }
  return removed
}

export async function durationOf(file: string): Promise<number | null> {
  return probeDuration(file)
}
