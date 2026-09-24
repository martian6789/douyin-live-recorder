/**
 * 主播库：监控与录制的数据源。
 *
 * 与 store 的分工：store 只负责「读/写 JSON」，这里负责业务规则——
 * 房间号解析、去重、排序权重维护、标签校验、导入导出、批量添加的逐项结果。
 * 任何写操作完成后都要 sync 给 monitor（重建任务）与 danmakuHub（订阅变更）。
 */
import { EventEmitter } from 'node:events'
import type { AddResult, LiveStatus, PlatformId, Streamer, StreamerStats } from '../shared/types'
import { getConfig, getCookie, getStreamers, setStreamers, getTags, setTags } from './store'
import { getProvider } from './providers'
import { parseDouyinSecUid, pendingRoomId } from './providers/douyin'
import { resolveRoomIdBySecUid } from './douyin-search'
import * as monitor from './monitor'
import { danmakuHub } from './danmaku-hub'
import { log } from './logger'

const L = log('streamers')

export const streamers = new EventEmitter()
streamers.setMaxListeners(0)

export function list(): Streamer[] {
  return getStreamers()
}

export function getById(id: string): Streamer | null {
  return getStreamers().find((s) => s.id === id) ?? null
}

export function getByTags(tagIds: string[]): Streamer[] {
  if (!tagIds.length) return getStreamers()
  const set = new Set(tagIds)
  return getStreamers().filter((s) => s.tags.some((t) => set.has(t)))
}

export function makeId(platform: PlatformId, roomId: string): string {
  return `${platform}:${roomId}`
}

function ctxOf(platform: PlatformId): { ua: string; cookie: string } {
  return { ua: getConfig().userAgent, cookie: getCookie(platform) }
}

/** 下一个 order：排在末尾 */
function nextOrder(list: Streamer[]): number {
  return list.reduce((m, s) => Math.max(m, s.order ?? 0), 0) + 10
}

/** 解析用户输入（链接或房间号）→ 真实房间号 */
export function parseInput(platform: PlatformId, input: string): string | null {
  const raw = (input || '').trim()
  if (!raw) return null
  try {
    return getProvider(platform).parseRoomId(raw)
  } catch {
    return null
  }
}

/* ============================ 增 ============================ */

export interface AddStreamerInput {
  platform: PlatformId
  /** 链接或房间号；抖音也可以是主页链接 https://www.douyin.com/user/<sec_uid> */
  input: string
  /** 已知的主播 sec_uid（抖音搜索结果直接传，省一次解析） */
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

export interface AddOutcome {
  streamer?: Streamer
  created: boolean
  error?: string
  /** 添加时探测房间信息失败的原因（主播名可能不准，稍后点「检测」会补全） */
  checkError?: string
}

/** 添加（或返回已存在的）主播；会顺带探测一次房间信息回填名字/头像 */
export async function add(inputOne: AddStreamerInput, quiet = false): Promise<AddOutcome> {
  const platform = inputOne.platform
  let roomId = parseInput(platform, inputOne.input)

  // 抖音：主播没开播时根本不存在对外直播间号，但主页地址是永久固定的。
  // 这种「待开播」主播先按 sec_uid 入库，交给监控轮询补房间号。
  let secUid =
    platform === 'douyin'
      ? inputOne.secUid?.trim() ||
        parseDouyinSecUid(inputOne.secUid ?? '') ||
        parseDouyinSecUid(inputOne.input) ||
        undefined
      : undefined

  const id = roomId ? makeId(platform, roomId) : secUid ? `${platform}:sec:${secUid}` : ''
  if (!id) {
    return {
      created: false,
      error:
        platform === 'douyin'
          ? '无法识别。抖音可填：直播间链接 / 房间号 / 主播主页链接（https://www.douyin.com/user/...）'
          : '无法识别房间号或链接'
    }
  }

  const list = getStreamers()
  // 同一个主播可能一个走主页、一个走房间号，两种 id 都要判重
  const exist =
    list.find((s) => s.id === id) ??
    (roomId ? list.find((s) => s.platform === platform && s.roomId === roomId) : undefined) ??
    (secUid ? list.find((s) => s.platform === platform && s.secUid === secUid) : undefined)
  if (exist) {
    if (!quiet) L.info('主播已存在，跳过', id)
    return { streamer: exist, created: false }
  }

  let name = inputOne.name?.trim() || ''
  let avatar: string | undefined = inputOne.avatar
  let roomTitle: string | undefined
  let coverUrl: string | undefined
  let liveStatus: LiveStatus = 'unknown'
  let checkError: string | undefined
  let awaitingRoom = false

  if (!roomId && secUid) {
    // 先在开播时抓一次房间号；抓不到说明对方当前没在播（这是正常结果）
    const r = await resolveRoomIdBySecUid(secUid)
    if (r.roomId) {
      roomId = r.roomId
      L.info('按主页反查到直播间号', { secUid, roomId })
    } else {
      awaitingRoom = true
      liveStatus = 'offline'
      checkError =
        r.error ??
        '未开播：抖音此时不提供直播间号，已加入监控 —— 开播会自动识别房间号并按设置录制'
      L.info('主播未开播，按主页入库待监控', { secUid, needCookie: !!r.needCookie })
    }
  }

  if (roomId) {
    try {
      const info = await getProvider(platform).getRoomInfo(roomId, ctxOf(platform))
      name = name || info.anchor || info.title || `房间${roomId}`
      avatar = avatar || info.avatar
      roomTitle = info.title
      coverUrl = info.cover
      liveStatus = info.live ? 'living' : 'offline'
      if (info.live) checkError = undefined
      // 直播间页面里能挖到主播 sec_uid：存下来，将来换号了也能按主页反查
      if (!secUid && info.secUid) secUid = info.secUid
    } catch (e: any) {
      // 探测失败不阻断添加：留空名字，交给监控轮询补全
      checkError = e?.message ?? String(e)
      name = name || `房间${roomId}`
      liveStatus = 'error'
      L.warn('添加时探测失败', id, checkError)
    }
  }

  if (!name) name = `待开播 ${secUid?.slice(0, 8) ?? roomId}`

  const now = Date.now()
  const s: Streamer = {
    id,
    platform,
    roomId: roomId || pendingRoomId(secUid!),
    secUid,
    homeUrl: inputOne.homeUrl ?? (secUid ? `https://www.douyin.com/user/${secUid}` : undefined),
    douyinId: inputOne.douyinId,
    liveUrl: inputOne.liveUrl,
    awaitingRoom,
    name,
    avatar,
    roomTitle,
    coverUrl,
    remark: inputOne.remark,
    tags: (inputOne.tags ?? []).filter((t) => getTags().some((x) => x.id === t)),
    saveDir: inputOne.saveDir,
    autoRecord: !!inputOne.autoRecord,
    top: false,
    order: nextOrder(list),
    quality: inputOne.quality,
    danmakuEnabled: inputOne.danmakuEnabled !== false,
    createdAt: now,
    updatedAt: now,
    liveStatus,
    lastCheckAt: Date.now(),
    checkError
  }

  list.push(s)
  setStreamers(list)
  monitor.addTask(s)
  syncDanmaku()
  emitChanged()
  L.info('已添加主播', `${s.name}(${id})`)
  return { streamer: s, created: true, checkError }
}

/** 多行文本批量添加：一行一个链接或房间号 */
export async function batchAdd(platform: PlatformId, text: string): Promise<AddResult> {
  const lines = (text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const uniq = [...new Set(lines)]
  const result: AddResult = { ok: true, added: 0, skipped: 0, failed: 0, items: [] }

  for (let i = 0; i < uniq.length; i++) {
    const line = uniq[i]
    try {
      const out = await add({ platform, input: line }, true)
      if (out.error) {
        result.failed += 1
        result.items.push({ input: line, ok: false, error: out.error })
      } else if (out.created) {
        result.added += 1
        result.items.push({ input: line, ok: true, name: out.streamer?.name, roomId: out.streamer?.roomId })
      } else {
        result.skipped += 1
        result.items.push({ input: line, ok: true, name: out.streamer?.name, roomId: out.streamer?.roomId, error: '已存在' })
      }
    } catch (e: any) {
      result.failed += 1
      result.items.push({ input: line, ok: false, error: e?.message ?? String(e) })
    }
    streamers.emit('import-progress', {
      total: uniq.length,
      done: i + 1,
      current: line,
      kind: 'import'
    })
  }

  result.ok = result.failed === 0
  streamers.emit('import-complete', result)
  emitChanged()
  return result
}

/* ==================== 按「搜索结果 / 关注列表」批量导入 ==================== */

export interface ImportUsersOutcome {
  added: number
  skipped: number
  failed: number
  errors: string[]
}

/**
 * 批量导入抖音主播。
 * 有直播间号的直接入库；只有主页的按 sec_uid 入库挂监控，开播后自动补号。
 */
export async function importDouyinUsers(
  users: {
    secUid?: string
    nickname?: string
    homeUrl?: string
    liveUrl?: string
    douyinId?: string
    roomUrl?: string
    roomId?: string
    avatar?: string
  }[],
  autoRecord?: boolean
): Promise<ImportUsersOutcome> {
  const out: ImportUsersOutcome = { added: 0, skipped: 0, failed: 0, errors: [] }
  for (const u of users ?? []) {
    const nm = u.nickname || u.secUid || '?'
    if (!u.secUid && !u.roomId) {
      out.failed += 1
      out.errors.push(`${nm}：缺少标识`)
      continue
    }
    try {
      const r = await add(
        {
          platform: 'douyin',
          input: u.roomUrl || u.liveUrl || u.homeUrl || '',
          secUid: u.secUid,
          homeUrl: u.homeUrl,
          liveUrl: u.liveUrl,
          douyinId: u.douyinId,
          avatar: u.avatar,
          name: u.nickname,
          // 没直播间号的（未开播）目的就是等他开播抓一次，默认把自动录打开
          autoRecord: autoRecord ?? (!u.roomId || undefined)
        },
        true
      )
      if (r.error) {
        out.failed += 1
        out.errors.push(`${nm}：${r.error}`)
      } else if (r.created) {
        out.added += 1
      } else {
        out.skipped += 1
      }
    } catch (e: any) {
      out.failed += 1
      out.errors.push(`${nm}：${e?.message ?? e}`)
    }
  }
  emitChanged()
  L.info('批量导入抖音主播', out)
  return out
}

/* ============================ 改 ============================ */

export function update(id: string, patch: Partial<Streamer>): Streamer[] {
  const list = getStreamers()
  const i = list.findIndex((s) => s.id === id)
  if (i < 0) return list
  const merged: Streamer = { ...list[i], ...patch, id, updatedAt: Date.now() }
  if (patch.tags) merged.tags = patch.tags.filter((t) => getTags().some((x) => x.id === t))
  list[i] = merged
  setStreamers(list)

  // 影响监控/弹幕的字段变化时需要同步
  if (patch.roomId || patch.platform || patch.autoRecord != null || patch.danmakuEnabled != null || patch.name || patch.quality) {
    monitor.addTask(merged)
    syncDanmaku()
  }
  emitChanged()
  return getStreamers()
}

export function remove(id: string): Streamer[] {
  const list = getStreamers().filter((s) => s.id !== id)
  setStreamers(list)
  monitor.removeTask(id)
  danmakuHub.unsubscribe(id)
  emitChanged()
  L.info('已删除主播', id)
  return list
}

export function toggleAutoRecord(id: string): boolean {
  const s = getById(id)
  if (!s) return false
  const next = !s.autoRecord
  update(id, { autoRecord: next })
  return next
}

export function toggleTop(id: string): void {
  const s = getById(id)
  if (!s) return
  const list = getStreamers()
  const i = list.findIndex((x) => x.id === id)
  list[i] = { ...s, top: !s.top, updatedAt: Date.now() }
  setStreamers(list)
  emitChanged()
}

/** 重排：把 order 规整成 10/20/30… 避免长期操作后权重膨胀 */
function normalizeOrder(list: Streamer[]): Streamer[] {
  list.forEach((s, i) => {
    s.order = (i + 1) * 10
  })
  return list
}

export function move(id: string, dir: 'up' | 'down' | 'bottom'): Streamer[] {
  const list = normalizeOrder(getStreamers())
  const i = list.findIndex((s) => s.id === id)
  if (i < 0) return list

  if (dir === 'up' && i > 0) {
    ;[list[i - 1], list[i]] = [list[i], list[i - 1]]
  } else if (dir === 'down' && i < list.length - 1) {
    ;[list[i + 1], list[i]] = [list[i], list[i + 1]]
  } else if (dir === 'bottom' && i < list.length - 1) {
    const [item] = list.splice(i, 1)
    list.push(item)
  }

  setStreamers(normalizeOrder(list))
  emitChanged()
  return getStreamers()
}

export function resetPosition(): Streamer[] {
  const list = getStreamers().map((s) => ({ ...s, top: false, order: 0 }))
  setStreamers(list)
  emitChanged()
  return getStreamers()
}

/* ============================ 查 ============================ */

export function checkExists(platform: PlatformId, input: string): { exists: boolean; streamer?: Streamer; roomId?: string | null } {
  const roomId = parseInput(platform, input)
  if (!roomId) return { exists: false, roomId: null }
  const s = getStreamers().find((x) => x.id === makeId(platform, roomId))
  return { exists: !!s, streamer: s, roomId }
}

export function stats(): StreamerStats {
  const list = getStreamers()
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const edge = start.getTime()
  const byPlatform: Record<string, number> = {}
  let living = 0
  let autoRecord = 0
  let todayNew = 0
  for (const s of list) {
    byPlatform[s.platform] = (byPlatform[s.platform] ?? 0) + 1
    if (s.liveStatus === 'living') living += 1
    if (s.autoRecord) autoRecord += 1
    if (s.createdAt >= edge) todayNew += 1
  }
  return { total: list.length, living, autoRecord, byPlatform, todayNew }
}

/** 手动探测一个主播（界面上的「立即检测」） */
export async function check(id: string): Promise<LiveStatus> {
  return monitor.checkOne(id)
}

/* ============================ 导入 / 导出 ============================ */

export interface ExportedData {
  version: number
  exportedAt: number
  streamers: Streamer[]
  tags: ReturnType<typeof getTags>
}

export function exportData(): ExportedData {
  return { version: 1, exportedAt: Date.now(), streamers: getStreamers(), tags: getTags() }
}

export function importData(data: unknown): { added: number; skipped: number; error?: string } {
  const d = data as Partial<ExportedData>
  if (!d || !Array.isArray(d.streamers)) return { added: 0, skipped: 0, error: '文件格式不正确' }

  // 标签先并入（同名去重）
  if (Array.isArray(d.tags)) {
    const cur = getTags()
    for (const t of d.tags) {
      if (!t?.name) continue
      if (cur.some((x) => x.name === t.name)) continue
      cur.push({ ...t, id: t.id || `tag-${Date.now().toString(36)}` })
    }
    setTags(cur)
  }

  const list = getStreamers()
  const have = new Set(list.map((s) => s.id))
  let added = 0
  let skipped = 0
  for (const s of d.streamers) {
    if (!s?.platform || !s?.roomId) {
      skipped += 1
      continue
    }
    const id = makeId(s.platform, s.roomId)
    if (have.has(id)) {
      skipped += 1
      continue
    }
    have.add(id)
    list.push({
      ...s,
      id,
      tags: Array.isArray(s.tags) ? s.tags : [],
      order: s.order ?? nextOrder(list),
      createdAt: s.createdAt ?? Date.now(),
      updatedAt: Date.now()
    })
    added += 1
  }
  setStreamers(list)
  monitor.initFromStreamers()
  syncDanmaku()
  emitChanged()
  return { added, skipped }
}

/* ============================ 与监控 / 弹幕联动 ============================ */

/** 按主播的 danmakuEnabled 全量对齐弹幕订阅 */
export function syncDanmaku(): void {
  try {
    danmakuHub.sync(getStreamers())
  } catch (e: any) {
    L.warn('弹幕订阅同步失败', e?.message ?? e)
  }
}

function emitChanged(): void {
  streamers.emit('changed', getStreamers())
  streamers.emit('stats', stats())
}
