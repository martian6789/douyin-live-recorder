/**
 * 分段合并：把 xxxx_001.mp4 / xxxx_002.mp4 … 无损合成一个文件。
 *
 * 用 concat demuxer + `-c copy`（要求同编码，本项目分段都是同一 ffmpeg 产出的，成立）。
 * 合并成功后可选删除原分段，并把历史记录里的分段替换成合并后的文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { HistoryItem, RunningJob } from '../shared/types'
import { getHistory, setHistory, setJobs, getJobs } from './store'
import { buildConcatListArgs, requireFfmpeg, run } from './ffmpeg'
import { isSegment, segmentBase } from './danmaku'
import { log } from './logger'

const L = log('merger')

export const merger = new EventEmitter()
merger.setMaxListeners(0)

const VIDEO_EXT = new Set(['.mp4', '.ts', '.mkv', '.flv', '.mov', '.m4v'])

export interface MergeGroup {
  /** 合并后的目标文件 */
  output: string
  /** 分段文件（已按序号排好） */
  files: string[]
  dir: string
  totalBytes: number
  /** 已存在合并结果 */
  exists: boolean
}

function segIndex(f: string): number {
  const m = /_(\d{3,4})\.[a-z0-9]+$/i.exec(path.basename(f))
  return m ? Number(m[1]) : 0
}

export function listVideos(dir: string, recursive = false): string[] {
  const out: string[] = []
  const walk = (d: string, depth: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (recursive && depth < 4) walk(p, depth + 1)
      } else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
        out.push(p)
      }
    }
  }
  walk(dir, 0)
  return out
}

/** 扫描目录，找出所有「有多个分段的组」 */
export function scanGroups(dir: string, recursive = true): MergeGroup[] {
  const files = listVideos(dir, recursive).filter(isSegment)
  const groups = new Map<string, string[]>()
  for (const f of files) {
    const base = segmentBase(f)
    const arr = groups.get(base) ?? []
    arr.push(f)
    groups.set(base, arr)
  }

  const out: MergeGroup[] = []
  for (const [base, arr] of groups) {
    if (arr.length < 2) continue
    arr.sort((a, b) => segIndex(a) - segIndex(b))
    const output = base
    let total = 0
    for (const f of arr) {
      try {
        total += fs.statSync(f).size
      } catch {
        /* ignore */
      }
    }
    out.push({
      output,
      files: arr,
      dir: path.dirname(base),
      totalBytes: total,
      exists: fs.existsSync(output)
    })
  }
  return out.sort((a, b) => b.files.length - a.files.length)
}

/* ============================ 合并执行 ============================ */

export interface MergeOptions {
  deleteSource?: boolean
  /** 已存在输出时覆盖 */
  overwrite?: boolean
}

export async function mergeGroup(g: MergeGroup, opts: MergeOptions = {}): Promise<RunningJob> {
  const job: RunningJob = {
    id: `merge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind: 'merge',
    file: g.output,
    status: 'running',
    progress: 0,
    startedAt: Date.now()
  }
  merger.emit('progress', job)

  if (g.exists && !opts.overwrite) {
    job.status = 'error'
    job.error = '目标文件已存在（未开启覆盖）'
    job.endedAt = Date.now()
    merger.emit('progress', job)
    return job
  }

  const listFile = path.join(g.dir, `.merge-${Date.now().toString(36)}.txt`)
  try {
    requireFfmpeg()
    fs.writeFileSync(
      listFile,
      g.files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8'
    )

    const tmpOut = `${g.output}.merging${path.extname(g.output)}`
    try {
      fs.unlinkSync(tmpOut)
    } catch {
      /* ignore */
    }

    const r = await run(requireFfmpeg(), buildConcatListArgs(listFile, tmpOut), 6 * 3600_000)
    if (r.code !== 0 || !fs.existsSync(tmpOut)) {
      job.status = 'error'
      job.error = (r.stderr || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 500)
      job.endedAt = Date.now()
      merger.emit('progress', job)
      return job
    }

    fs.renameSync(tmpOut, g.output)
    job.progress = 100
    job.status = 'done'
    job.outputFile = g.output
    job.endedAt = Date.now()

    if (opts.deleteSource) {
      for (const f of g.files) {
        try {
          fs.unlinkSync(f)
        } catch {
          /* ignore */
        }
      }
    }
    replaceHistory(g.files, g.output)
    merger.emit('progress', job)
    merger.emit('completed', g.output)
    L.info('合并完成', g.output)
  } catch (e: any) {
    job.status = 'error'
    job.error = e?.message ?? String(e)
    job.endedAt = Date.now()
    merger.emit('progress', job)
  } finally {
    try {
      fs.unlinkSync(listFile)
    } catch {
      /* ignore */
    }
  }
  return job
}

/** 合并后把历史里的分段记录替换成一条合并记录 */
function replaceHistory(segments: string[], output: string): void {
  const segSet = new Set(segments)
  const list = getHistory()
  const hit = list.filter((h) => segSet.has(h.file))
  if (!hit.length) return
  let size = 0
  try {
    size = fs.statSync(output).size
  } catch {
    /* ignore */
  }
  const merged: HistoryItem = {
    ...hit[0],
    id: `m-${Date.now().toString(36)}`,
    file: output,
    dir: path.dirname(output),
    sizeBytes: size,
    durationMs: hit.reduce((a, b) => a + b.durationMs, 0),
    startedAt: Math.min(...hit.map((h) => h.startedAt)),
    endedAt: Math.max(...hit.map((h) => h.endedAt)),
    merged: true
  }
  setHistory([merged, ...list.filter((h) => !segSet.has(h.file))])
}

/* ============================ 批量 ============================ */

export async function startBatchMerge(
  groups: MergeGroup[],
  opts: MergeOptions = {}
): Promise<RunningJob[]> {
  const jobs: RunningJob[] = []
  for (const g of groups) {
    const j = await mergeGroup(g, opts)
    jobs.push(j)
    merger.emit('batch-progress', { total: groups.length, done: jobs.length, current: g.output })
  }
  setJobs('merge', [...jobs, ...getJobs<RunningJob>('merge')])
  return jobs
}

/* ============================ 自动合并任务 ============================ */

interface AutoTask {
  dir: string
  files: string[]
  createdAt: number
  reason: string
}

export function queueAutoTask(dir: string, files: string[], reason = '录制结束自动合并'): void {
  const list = getJobs<AutoTask>('merge-auto')
  list.unshift({ dir, files, createdAt: Date.now(), reason })
  setJobs('merge-auto', list)
  merger.emit('auto-tasks', list)
}

export function getAutoTasks(): AutoTask[] {
  return getJobs<AutoTask>('merge-auto')
}

export function clearAutoTasks(): void {
  setJobs('merge-auto', [])
  merger.emit('auto-tasks', [])
}
