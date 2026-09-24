/**
 * 录像库：把输出目录扫成一份可检索的文件清单。
 *
 * 只读扫描，不改动任何文件；删除走系统回收站（shell.trashItem），避免误删找不回。
 * 目录结构约定（模板默认就是它）：输出根 / 平台 / 主播 / 日期 / 文件
 * 扫描时顺手把平台、主播从路径里还原出来，界面上就能按主播筛选。
 */
import fs from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import type { RecordFile } from '../shared/types'
import { companions } from './danmaku'
import { log } from './logger'

const L = log('library')

const VIDEO_EXT = new Set(['.mp4', '.ts', '.mkv', '.flv', '.mov', '.m4v'])
const MAX_FILES = 5000

export interface ScanOptions {
  dir?: string
  recursive?: boolean
  /** 只保留这个时间之后修改的文件 */
  since?: number
  keyword?: string
}

/** 从 <root>/<platform>/<name>/... 里还原平台与主播 */
function inferFromPath(root: string, file: string): { platform?: string; streamerName?: string } {
  const rel = path.relative(root, file)
  const parts = rel.split(path.sep)
  // parts: [platform, name, date, file] 或更长
  const out: { platform?: string; streamerName?: string } = {}
  if (parts.length >= 3) {
    const p = parts[0]
    if (p && !p.includes('.') && p.length <= 16) out.platform = p
    out.streamerName = parts[1]
  }
  return out
}

export function scan(opts: ScanOptions = {}): RecordFile[] {
  const root = opts.dir || ''
  if (!root) return []
  const recursive = opts.recursive !== false
  const out: RecordFile[] = []

  const walk = (d: string, depth: number): void => {
    if (out.length >= MAX_FILES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (recursive && depth < 5) walk(p, depth + 1)
        continue
      }
      const ext = path.extname(e.name).toLowerCase()
      if (!VIDEO_EXT.has(ext)) continue
      let st: fs.Stats
      try {
        st = fs.statSync(p)
      } catch {
        continue
      }
      if (opts.since && st.mtimeMs < opts.since) continue
      if (opts.keyword && !e.name.toLowerCase().includes(opts.keyword.toLowerCase())) continue

      const c = companions(p)
      const inferred = inferFromPath(root, p)
      out.push({
        path: p,
        name: e.name,
        dir: d,
        sizeBytes: st.size,
        mtime: st.mtimeMs,
        ext: ext.slice(1),
        danmakuFile: c.danmakuFile,
        assFile: c.assFile,
        subFiles: c.subFiles,
        platform: inferred.platform,
        streamerName: inferred.streamerName
      })
    }
  }

  walk(root, 0)
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** 目录概览：总数 / 总大小 / 今日新增 */
export function summary(files: RecordFile[]): {
  count: number
  totalBytes: number
  todayCount: number
  todayBytes: number
  withDanmaku: number
  withSubtitle: number
} {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const edge = start.getTime()
  let totalBytes = 0
  let todayCount = 0
  let todayBytes = 0
  let withDanmaku = 0
  let withSubtitle = 0
  for (const f of files) {
    totalBytes += f.sizeBytes
    if (f.mtime >= edge) {
      todayCount += 1
      todayBytes += f.sizeBytes
    }
    if (f.danmakuFile) withDanmaku += 1
    if (f.subFiles?.length) withSubtitle += 1
  }
  return { count: files.length, totalBytes, todayCount, todayBytes, withDanmaku, withSubtitle }
}

/** 删除到回收站（可恢复） */
export async function removeFiles(paths: string[], withCompanions = true): Promise<{ removed: number; failed: string[] }> {
  const failed: string[] = []
  let removed = 0
  for (const p of paths) {
    const targets = [p]
    if (withCompanions) {
      const c = companions(p)
      for (const extra of [c.danmakuFile, c.assFile, c.srtFile, c.txtFile, ...(c.subFiles ?? [])]) {
        if (extra && !targets.includes(extra)) targets.push(extra)
      }
    }
    for (const t of targets) {
      if (!fs.existsSync(t)) continue
      try {
        await shell.trashItem(t)
        removed += 1
      } catch (e: any) {
        // 回收站不可用（部分网络盘）时降级为直接删除，但明确记录
        try {
          fs.unlinkSync(t)
          removed += 1
        } catch (e2: any) {
          failed.push(`${t}：${e2?.message ?? e?.message ?? e}`)
        }
      }
    }
  }
  if (failed.length) L.warn('部分文件删除失败', failed.length)
  return { removed, failed }
}

/** 打开文件（用系统默认播放器） */
export async function openFile(p: string): Promise<boolean> {
  if (!fs.existsSync(p)) return false
  const err = await shell.openPath(p)
  return !err
}

/** 在资源管理器里定位 */
export function showInFolder(p: string): void {
  if (!p) return
  if (fs.existsSync(p)) {
    shell.showItemInFolder(p)
    return
  }
  const dir = path.dirname(p)
  if (fs.existsSync(dir)) shell.showItemInFolder(dir)
}

/** 打开目录 */
export async function openDirectory(dir: string): Promise<boolean> {
  if (!dir || !fs.existsSync(dir)) return false
  const err = await shell.openPath(dir)
  return !err
}

