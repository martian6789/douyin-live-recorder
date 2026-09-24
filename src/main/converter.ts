/**
 * 批量转码 / 转封装。
 *
 * 默认「转封装」（-c copy），换容器不改画质、几秒钟完成；
 * 需要改编码时勾选重编码（H.264 + AAC），速度慢但兼容性最好。
 */
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import type { RunningJob } from '../shared/types'
import { setJobs, getJobs } from './store'
import { buildConvertArgs, probeMedia, requireFfmpeg, type MediaInfo } from './ffmpeg'
import { listVideos } from './merger'
import { log } from './logger'

const L = log('converter')

export const converter = new EventEmitter()
converter.setMaxListeners(0)

export interface ConvertItem {
  file: string
  name: string
  dir: string
  sizeBytes: number
  durationMs?: number
  info?: MediaInfo
}

export async function scanFiles(dir: string, recursive = true): Promise<ConvertItem[]> {
  const files = listVideos(dir, recursive)
  const out: ConvertItem[] = []
  for (const f of files) {
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
      sizeBytes: size
    })
  }
  return out.sort((a, b) => b.sizeBytes - a.sizeBytes)
}

export interface ConvertOptions {
  container: 'mp4' | 'ts' | 'mkv' | 'flv'
  /** 重编码（慢）；false = 仅换容器 */
  reencode?: boolean
  /** 输出目录，留空 = 原目录 */
  outDir?: string
  /** 覆盖已存在文件 */
  overwrite?: boolean
  /** 完成后删除源文件 */
  deleteSource?: boolean
}

function buildArgs(input: string, output: string, o: ConvertOptions): string[] {
  if (!o.reencode) return buildConvertArgs(input, output, o.container)
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-i',
    input,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '22',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-f',
    o.container === 'mp4' ? 'mp4' : o.container,
    '-y',
    output
  ]
}

export function convertOne(item: ConvertItem, o: ConvertOptions): Promise<RunningJob> {
  return new Promise((resolve) => {
    const job: RunningJob = {
      id: `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'convert',
      file: item.file,
      status: 'running',
      progress: 0,
      startedAt: Date.now()
    }
    converter.emit('progress', job)

    const base = path.basename(item.file).replace(/\.[^.]+$/, '')
    const outDir = o.outDir || item.dir
    fs.mkdirSync(outDir, { recursive: true })
    const output = path.join(outDir, `${base}.${o.container}`)

    if (fs.existsSync(output) && output !== item.file && !o.overwrite) {
      job.status = 'error'
      job.error = '目标文件已存在'
      job.endedAt = Date.now()
      converter.emit('progress', job)
      resolve(job)
      return
    }
    if (path.resolve(output) === path.resolve(item.file)) {
      job.status = 'error'
      job.error = '输出与输入相同，请更换容器或输出目录'
      job.endedAt = Date.now()
      converter.emit('progress', job)
      resolve(job)
      return
    }

    const totalUs = (item.durationMs ?? 0) * 1000
    const args = [
      '-hide_banner',
      '-progress',
      'pipe:1',
      '-stats_period',
      '1',
      ...buildArgs(item.file, output, o)
    ]

    let stderrTail = ''
    let proc
    try {
      proc = spawn(requireFfmpeg(), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e: any) {
      job.status = 'error'
      job.error = e?.message ?? String(e)
      job.endedAt = Date.now()
      converter.emit('progress', job)
      resolve(job)
      return
    }

    proc.stdout?.on('data', (b: Buffer) => {
      for (const line of b.toString('utf8').split(/\r?\n/)) {
        const [k, v] = line.split('=')
        if (k === 'out_time_us' || k === 'out_time_ms') {
          const us = Number(v)
          if (totalUs > 0 && Number.isFinite(us)) {
            job.progress = Math.max(0, Math.min(99, Math.round((us / totalUs) * 100)))
            job.message = `${job.progress}%`
            converter.emit('progress', job)
          }
        } else if (k === 'progress' && v === 'end') {
          job.progress = 100
          converter.emit('progress', job)
        }
      }
    })
    proc.stderr?.on('data', (b: Buffer) => {
      stderrTail = (stderrTail + b.toString('utf8')).slice(-3000)
    })

    proc.on('error', (e) => {
      job.status = 'error'
      job.error = e.message
      job.endedAt = Date.now()
      converter.emit('progress', job)
      resolve(job)
    })

    proc.on('exit', (code) => {
      const ok = code === 0 && fs.existsSync(output)
      job.status = ok ? 'done' : 'error'
      job.outputFile = ok ? output : undefined
      if (!ok) {
        job.error =
          (stderrTail.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ') || `退出码 ${code}`).slice(
            0,
            500
          )
      }
      job.endedAt = Date.now()
      converter.emit('progress', job)
      if (ok && o.deleteSource) {
        try {
          fs.unlinkSync(item.file)
        } catch {
          /* ignore */
        }
      }
      L.info('转码结束', item.file, job.status)
      resolve(job)
    })
  })
}

export async function startBatchConvert(
  items: ConvertItem[],
  o: ConvertOptions
): Promise<RunningJob[]> {
  const jobs: RunningJob[] = []
  for (const it of items) {
    jobs.push(await convertOne(it, o))
    converter.emit('batch-progress', { total: items.length, done: jobs.length, current: it.name })
  }
  setJobs('convert', [...jobs, ...getJobs<RunningJob>('convert')])
  return jobs
}

/** 顺手补一个探测接口给界面显示时长 */
export async function inspect(file: string): Promise<MediaInfo> {
  return probeMedia(file)
}
