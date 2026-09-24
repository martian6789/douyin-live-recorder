/**
 * 磁盘空间看护。
 *
 * 长时间无人值守录制最怕的就是「盘满了还不知道」——录到一半文件损坏、甚至系统卡死。
 * 这里定时查剩余空间，低于阈值可以只提醒，也可以直接停止录制、或清理最旧的录像。
 */
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { DiskMonitorStatus, DiskUsage } from '../shared/types'
import { getConfig } from './store'
import { stopAll } from './recorder'
import { log } from './logger'

const L = log('disk')

export const disk = new EventEmitter()
disk.setMaxListeners(0)

let timer: NodeJS.Timeout | null = null
let running = false
let lastCheckAt = 0
let nextCheckAt = 0
let lastUsage: DiskUsage | undefined
let warningCount = 0

/** 取某个路径所在分区的使用情况 */
export function getUsage(target?: string): DiskUsage {
  const cfg = getConfig()
  const p = target || cfg.disk.path || cfg.outputDir
  const now = Date.now()
  try {
    const st: any = fs.statfsSync(p)
    const total = Number(st.blocks) * Number(st.bsize)
    const free = Number(st.bavail) * Number(st.bsize)
    const used = total - Number(st.bfree) * Number(st.bsize)
    const usage: DiskUsage = {
      path: p,
      totalBytes: total,
      freeBytes: free,
      usedPercent: total ? Math.round((used / total) * 1000) / 10 : 0,
      checkedAt: now,
      warning: false
    }
    const recDir = cfg.outputDir
    usage.recordBytes = dirSize(recDir, 2)
    usage.warning = free / 1024 ** 3 < cfg.disk.minFreeGB
    lastUsage = usage
    return usage
  } catch (e: any) {
    const usage: DiskUsage = {
      path: p,
      totalBytes: 0,
      freeBytes: 0,
      usedPercent: 0,
      checkedAt: now,
      warning: false,
      error: e?.message ?? String(e)
    }
    lastUsage = usage
    return usage
  }
}

/** 浅层统计目录体积（默认只下钻 depth 层，避免卡在几十万文件上） */
export function dirSize(dir: string, depth = 3): number {
  let total = 0
  const walk = (d: string, level: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      try {
        if (e.isDirectory()) {
          if (level < depth) walk(p, level + 1)
        } else {
          total += fs.statSync(p).size
        }
      } catch {
        /* ignore */
      }
    }
  }
  walk(dir, 0)
  return total
}

/* ============================ 监控 ============================ */

export function start(): void {
  const cfg = getConfig()
  if (running) stop()
  if (!cfg.disk.enabled) return
  running = true
  const interval = Math.max(1, cfg.disk.checkIntervalMin) * 60_000
  nextCheckAt = Date.now() + interval
  timer = setInterval(() => void check(), interval)
  void check()
  L.info('磁盘监控已启动', `${cfg.disk.minFreeGB}GB 阈值`)
}

export function stop(): void {
  running = false
  if (timer) clearInterval(timer)
  timer = null
  disk.emit('status', status())
}

export function restart(): DiskMonitorStatus {
  stop()
  start()
  return status()
}

export async function check(): Promise<DiskUsage> {
  const cfg = getConfig()
  lastCheckAt = Date.now()
  nextCheckAt = Date.now() + Math.max(1, cfg.disk.checkIntervalMin) * 60_000
  const usage = getUsage()

  if (usage.warning) {
    warningCount += 1
    const gb = (usage.freeBytes / 1024 ** 3).toFixed(1)
    L.warn(`磁盘剩余 ${gb}GB，低于阈值 ${cfg.disk.minFreeGB}GB`)
    disk.emit('warning', usage)

    if (cfg.disk.action === 'stop-record') {
      L.warn('按配置停止全部录制')
      stopAll()
    } else if (cfg.disk.action === 'clean-oldest') {
      const removed = cleanOldest(cfg.disk.keepDays)
      L.info('清理旧录像', removed)
    }
  } else if (lastUsage && !usage.warning) {
    warningCount = 0
  }

  disk.emit('status', status())
  disk.emit('usage', usage)
  return usage
}

/** 删除超过 keepDays 天的录像（只动配置的输出目录内、常见视频扩展名） */
export function cleanOldest(keepDays: number): { files: number; bytes: number } {
  const cfg = getConfig()
  const edge = Date.now() - Math.max(1, keepDays) * 86400_000
  const exts = new Set(['.mp4', '.ts', '.mkv', '.flv', '.mov'])
  let files = 0
  let bytes = 0

  const walk = (d: string, level: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (level < 3) walk(p, level + 1)
        continue
      }
      if (!exts.has(path.extname(e.name).toLowerCase())) continue
      try {
        const st = fs.statSync(p)
        if (st.mtimeMs < edge) {
          fs.unlinkSync(p)
          files += 1
          bytes += st.size
          // 伴随文件一起清
          for (const suffix of ['.danmaku.jsonl', '.danmaku.ass', '.srt', '.txt']) {
            const sib = p.replace(/\.[^.]+$/, '') + suffix
            if (fs.existsSync(sib)) fs.unlinkSync(sib)
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  walk(cfg.outputDir, 0)
  return { files, bytes }
}

export function status(): DiskMonitorStatus {
  return {
    running,
    lastCheckAt: lastCheckAt || undefined,
    nextCheckAt: nextCheckAt || undefined,
    lastUsage,
    warningCount
  }
}
