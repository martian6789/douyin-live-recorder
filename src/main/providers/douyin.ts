import type { RoomInfo, StreamVariant } from '../../shared/types'
import type { DanmakuClient, DanmakuHandlers, DanmakuPayload, LiveProvider, ProviderContext } from './types'
import { DEFAULT_REFERER, request } from './http'
import { registerDanmakuSink, unregisterDanmakuSink } from '../relay'
import { douyinDmStart, douyinDmStop } from '../danmaku-douyin'
import { log } from '../logger'

const L = log('douyin')

/**
 * 抖音直播。
 *
 * 说明：抖音 web 端房间接口受风控保护，实际可用与否取决于 Cookie 完整度
 * （常见必需项：ttwid、__ac_nonce、msToken、odin_tt），且部分接口还要
 * a_bogus / X-Bogus 签名。这里优先走官方 API；无 Cookie / 签名失败时
 * 自动降级为解析 `live.douyin.com/{web_rid}` 的 SSR 页面，仍能拿到
 * 主播名、真实 roomId、封面、流地址等基础信息。
 */
const ENTER_API = 'https://live.douyin.com/webcast/room/web/enter/'

interface EnterResp {
  status_code?: number
  data: {
    room?: {
      id_str?: string
      status?: number
      title?: string
      user_count?: number
      cover?: { url_list?: string[] }
      stream_url?: {
        flv_pull_url?: Record<string, string>
        hls_pull_url_map?: Record<string, string>
      }
      owner?: { nickname?: string; sec_uid?: string } | null
    }
    user?: { nickname?: string; sec_uid?: string }
  }
}

async function enter(rid: string, ctx: ProviderContext): Promise<EnterResp> {
  const qs = new URLSearchParams({
    web_rid: rid,
    aid: '6383',
    app_name: 'douyin_web',
    live_id: '1',
    device_platform: 'web',
    language: 'zh-CN',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '131.0.0.0',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080'
  })
  try {
    const res = await request(`${ENTER_API}?${qs.toString()}`, {
      cookie: ctx.cookie,
      referer: `https://live.douyin.com/${rid}`
    })
    return res.json<EnterResp>()
  } catch (e: any) {
    L.warn('[enter] 官方 API 失败', { rid, msg: e?.message ?? e })
    throw e
  }
}

/**
 * 无 Cookie 时的降级方案：请求直播间 HTML，提取 React Flight 数据。
 * 抖音把房间信息（主播、标题、封面、流地址）直接 SSR 到页面里，
 * 不需要签名即可读取。
 */
export async function enterFromPage(rid: string): Promise<EnterResp> {
  let html = ''
  try {
    const res = await request(`https://live.douyin.com/${rid}`, {
      referer: 'https://live.douyin.com/'
    })
    html = res.text
  } catch (e: any) {
    L.error('[enterFromPage] 拉取直播间页面失败', { rid, msg: e?.message ?? e })
    throw e
  }
  if (!html || html.length < 1000) {
    L.error('[enterFromPage] 页面为空或过短', { rid, len: html?.length ?? 0 })
    throw new Error('页面为空')
  }

  // 解码 React Flight chunks: self.__pace_f.push([1, "...转义字符串..."])
  const decoded: string[] = []
  const re = /self\.__pace_f\.push\(\[1,\s*"([\s\S]*?)"\]\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    try {
      decoded.push(JSON.parse('"' + m[1] + '"'))
    } catch {
      // 个别 chunk 可能不是合法 JSON 字符串，忽略
    }
  }
  const text = decoded.join('\n')
  if (!text) {
    L.error('[enterFromPage] 页面未包含房间数据（React Flight 解析为空）', {
      rid,
      htmlLen: html.length
    })
    throw new Error('页面未包含房间数据')
  }

  // 提取字段并跳过 $undefined
  const getField = (text: string, key: string) => {
    const re = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'g')
    let m
    while ((m = re.exec(text)) !== null) {
      if (m[1] !== '$undefined' && m[1] !== 'null') return m[1]
    }
    return null
  }

  const anchorBlock = (() => {
    const m = /"anchor"\s*:\s*\{[^{}]{0,500}?"nickname"\s*:\s*"([^"]+)"/.exec(text)
    return m && m[1] !== '$undefined' ? m[1] : null
  })()
  /**
   * 带 Cookie 时，页面里第一个 nickname 是**登录者自己**的账号信息（侧边栏），
   * 直接取第一个会把主播名填成用户自己的昵称。主播只在 room 的 anchor 对象里，
   * 必须优先从这里取 —— 实测：全局首个=「我」，anchor 块内=「老飘讲故事」。
   */
  const nickname = anchorBlock || getField(text, 'nickname') || ''
  const anchorSecUid = (() => {
    const m = /"anchor"\s*:\s*\{[^{}]{0,500}?"sec_uid"\s*:\s*"([^"]+)"/.exec(text)
    return m && m[1] !== '$undefined' && m[1].length > 10 ? m[1] : undefined
  })()
  const title = getField(text, 'title') || ''
  const roomId = getField(text, 'roomId') || rid

  const userCountMatch = text.match(/"user_count_str"\s*:\s*"(\d+)"/)
  const coverMatch = text.match(/"cover"\s*:\s*\{[^{}]*"url_list"\s*:\s*\[\s*"([^"]+)"/)

  // 流地址（FLV / HLS）
  const flvMap = extractUrlMap(text, 'flv_pull_url')
  const hlsMap = extractUrlMap(text, 'hls_pull_url_map')

  L.info('[enterFromPage] 解析成功', {
    rid,
    roomId,
    anchor: nickname,
    title,
    flv: Object.keys(flvMap).length,
    hls: Object.keys(hlsMap).length
  })

  return {
    status_code: 0,
    data: {
      room: {
        id_str: roomId,
        title: title,
        user_count: userCountMatch ? Number(userCountMatch[1]) : 0,
        cover: coverMatch ? { url_list: [coverMatch[1]] } : undefined,
        stream_url:
          Object.keys(flvMap).length || Object.keys(hlsMap).length
            ? { flv_pull_url: flvMap, hls_pull_url_map: hlsMap }
            : undefined,
        owner: nickname ? { nickname, sec_uid: anchorSecUid } : null
      },
      user: nickname ? { nickname, sec_uid: anchorSecUid } : undefined
    }
  }
}

/**
 * 校验一个「候选直播间号」是不是真能打开。
 *
 * 抖音有两套 id：对外短号 web_rid（如 754445813489，live.douyin.com 用的就是这个）
 * 和内部 19 位 roomId（如 7687806972725889843）。内部号直接拼进 URL 会拿到一个
 * 没有主播数据的空壳页 —— 关注列表接口返回的就是后者，所以拿到候选后必须过这一道。
 * 返回规范化后的可用短号；不可用返回 null。
 */
export async function normalizeRoomId(candidate: string): Promise<string | null> {
  const rid = String(candidate ?? '').trim()
  if (!rid || !/^\d{4,}$/.test(rid)) return null
  try {
    const j = await enterFromPage(rid)
    const ok = !!j?.data?.room?.owner?.nickname
    if (ok) {
      L.info('[normalizeRoomId] 候选号可用', { rid })
      return rid
    }
    L.warn('[normalizeRoomId] 候选号打开后没有主播数据（多半是内部 roomId）', { rid })
    return null
  } catch (e: any) {
    L.warn('[normalizeRoomId] 校验失败', { rid, msg: e?.message ?? e })
    return null
  }
}

function extractUrlMap(text: string, key: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = new RegExp('"' + key + '"\\s*:\\s*\\{([^{}]+?)\\}', 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const kvRe = /"([^"]+)"\s*:\s*"([^"]+)"/g
    let kv: RegExpExecArray | null
    while ((kv = kvRe.exec(m[1])) !== null) {
      out[kv[1]] = kv[2]
    }
  }
  return out
}

/** 直播间号占位符：主播未开播、只拿到主页时的临时 roomId */
export function pendingRoomId(secUid: string): string {
  return `sec:${secUid}`
}

export function isPendingRoomId(roomId: string): boolean {
  return typeof roomId === 'string' && roomId.startsWith('sec:')
}

/**
 * 解析「抖音主页」→ sec_uid。
 *
 * 支持：
 *  - https://www.douyin.com/user/MS4wLjABAAAA...（可带 ? 参数）
 *  - 裸 sec_uid（MS4wLjABAAAA... 或 _ 开头）
 * 主页地址是抖音唯一永久固定的主播标识，未开播也能拿到。
 */
export function parseDouyinSecUid(input: string): string | null {
  const s = (input || '').trim()
  if (!s) return null
  const m = /douyin\.com\/user\/([A-Za-z0-9_\-]{10,})/i.exec(s)
  if (m) return m[1]
  if (/^MS4wLjAB[A-Za-z0-9_\-]{10,}$/.test(s)) return s
  return null
}

export const douyinProvider: LiveProvider = {
  id: 'douyin',
  name: '抖音',
  danmakuSupported: false,

  parseRoomId(input: string): string | null {
    const s = input.trim()
    if (/^\d+$/.test(s)) return s
    const m = /live\.douyin\.com\/([A-Za-z0-9_-]+)/i.exec(s)
    if (m) return m[1]
    // https://www.douyin.com/follow/live/230572238214?anchor_id=...
    const m3 = /douyin\.com\/follow\/live\/(\d+)/i.exec(s)
    if (m3) return m3[1]
    // https://www.douyin.com/room/230572238214 等短链
    const m4 = /douyin\.com\/room\/(\d+)/i.exec(s)
    if (m4) return m4[1]
    const m2 = /douyin\.com\/user\/[^\/]*\?.*room_id=(\d+)/i.exec(s)
    return m2 ? m2[1] : null
  },

  async getRoomInfo(rid: string, ctx: ProviderContext): Promise<RoomInfo> {
    let room = await fetchRoom(rid, ctx)
    if (!room) {
      const msg = '房间不存在、未开播，或 Cookie 不完整（API 与页面降级均失败）'
      L.error('[getRoomInfo] 失败', { rid, msg })
      throw new Error(msg)
    }

    const ridReal = room.id_str ?? rid
    // HTML 解析时 status 字段不可靠，以是否有流地址判断在播
    const hasStream = !!(
      room.stream_url?.flv_pull_url &&
      Object.keys(room.stream_url.flv_pull_url).length
    )
    const info: RoomInfo = {
      platform: 'douyin',
      roomId: ridReal,
      title: String(room.title ?? ''),
      anchor: String(room.owner?.nickname ?? ''),
      // 主播主页 sec_uid：拿到了就存下来，以后可以按它反查直播间号
      secUid: room.owner?.sec_uid,
      cover: room.cover?.url_list?.[0],
      live: Number(room.status) === 2 || hasStream,
      audience: Number(room.user_count ?? 0)
    }
    L.info('[getRoomInfo] 成功', { rid, ridReal, anchor: info.anchor, title: info.title, live: info.live })
    return info
  },

  async getStreams(rid: string, ctx: ProviderContext): Promise<StreamVariant[]> {
    const room = await fetchRoom(rid, ctx)
    if (!room) {
      const msg = '获取房间信息失败：房间不存在、已下播，或需要完整 Cookie（API 与页面降级均失败）'
      L.error('[getStreams] 失败', { rid, msg })
      throw new Error(msg)
    }

    const su = room?.stream_url
    const hasAny =
      Object.keys(su?.flv_pull_url ?? {}).length > 0 || Object.keys(su?.hls_pull_url_map ?? {}).length > 0
    // 房间信息拿得到、但没有流地址 —— 绝大多数情况就是「没在播」，
    // 不要笼统甩锅给 Cookie，否则用户会白折腾半天。
    if (!hasAny) {
      L.warn('[getStreams] 无流地址（主播未在播）', { rid })
      throw new Error('主播当前未开播（页面里没有流地址）')
    }

    const out: StreamVariant[] = []
    const headers: Record<string, string> = { 'User-Agent': ctx.ua, Referer: DEFAULT_REFERER.douyin! }
    if (ctx.cookie) headers.Cookie = ctx.cookie

    const hlsMap = su?.hls_pull_url_map ?? {}
    for (const [quality, url] of Object.entries(hlsMap)) {
      if (typeof url === 'string') out.push({ quality, label: `${quality} · HLS`, url, format: 'hls', headers })
    }
    const flvMap = su?.flv_pull_url ?? {}
    for (const [quality, url] of Object.entries(flvMap)) {
      if (typeof url === 'string') out.push({ quality, label: `${quality} · FLV`, url, format: 'flv', headers })
    }
    if (out.length === 0) throw new Error('没有可用清晰度')
    L.info('[getStreams] 拿到流', { rid, count: out.length })
    return out
  },

  createDanmaku(roomId: string, _ctx: ProviderContext, h: DanmakuHandlers): DanmakuClient {
    // 弹幕 WebSocket 跑在隐藏 Chromium 窗口里：Node 的 TLS 指纹过不了抖音风控
    // （握手一律 DEVICE_BLOCKED 415，实测）。窗口解出的弹幕 POST 到本地中继 /dm，
    // 再经这里回传给 danmakuHub。
    // ctx.cookie 用不上：Chromium 会话自带登录窗口存下的抖音 Cookie（含 ttwid）。
    const DM_TYPES = new Set(['chat', 'gift', 'superchat', 'enter', 'like', 'system'])
    h.onStatus?.('connecting')
    registerDanmakuSink(roomId, (raw) => {
      const m = raw as Record<string, unknown> | null
      if (!m || typeof m !== 'object') return
      const st = m.__status
      if (typeof st === 'string') {
        if (st === 'open') h.onStatus?.('open')
        else if (st === 'connecting') h.onStatus?.('connecting')
        else if (st === 'closed') h.onStatus?.('closed')
        else if (st === 'error') h.onError?.(new Error(String(m.msg || '抖音弹幕连接失败')))
        return
      }
      if (typeof m.text === 'string' && m.text) {
        const payload: DanmakuPayload = {
          platform: 'douyin',
          roomId,
          type: DM_TYPES.has(String(m.type)) ? (m.type as DanmakuPayload['type']) : 'chat',
          user: String(m.user ?? ''),
          uid: String(m.uid ?? ''),
          text: m.text
        }
        if (typeof m.giftName === 'string') payload.giftName = m.giftName
        if (typeof m.giftCount === 'number') payload.giftCount = m.giftCount
        h.onMessage(payload)
      }
    })
    void douyinDmStart(roomId).catch((e: unknown) => {
      h.onError?.(e instanceof Error ? e : new Error(String(e)))
    })
    return {
      close: () => {
        unregisterDanmakuSink(roomId)
        douyinDmStop(roomId)
      }
    }
  }
}

/** 先走 API，失败/无数据则降级到 HTML 解析 */
async function fetchRoom(rid: string, ctx: ProviderContext): Promise<EnterResp['data']['room'] | undefined> {
  try {
    const j = await enter(rid, ctx)
    if (j?.data?.room) return j.data.room
    L.warn('[fetchRoom] 官方 API 返回但无 room 字段，降级到页面', { rid })
  } catch (e: any) {
    L.warn('[fetchRoom] 官方 API 异常，降级到页面', { rid, msg: e?.message ?? e })
  }
  try {
    const j = await enterFromPage(rid)
    if (j?.data?.room) return j.data.room
    L.error('[fetchRoom] 页面解析也无 room 字段', { rid })
  } catch (e: any) {
    L.error('[fetchRoom] 页面解析异常', { rid, msg: e?.message ?? e })
  }
  return undefined
}
