import type { RoomInfo, StreamVariant } from '../../shared/types'
import type { LiveProvider, ProviderContext } from './types'
import { NotImplementedError } from './types'
import { DEFAULT_REFERER, request } from './http'

/**
 * 快手直播。
 *
 * 可用性说明：快手 web 端接口会校验 Cookie 里的 `did` 与 `kuaishou.web.cp.api_ph`，
 * 缺了会返回 `result: 400002` 之类的业务错误码。因此**请先在「设置 → 平台 Cookie」填入完整 Cookie**。
 *
 * 解析上做了防御：不同版本返回的字段层级有差异（playUrls / adaptationSet.representation），
 * 两种形态都尝试一次，能拿到就用，拿不到给出明确原因，避免只报「失败」。
 */
const DETAIL_API = 'https://live.kuaishou.com/live_api/liveroom/livedetail'

interface Represent {
  url?: string
  name?: string
  level?: number
  qualityLabel?: string
  quality?: string
  bitrate?: number
}

interface PlayUrl {
  url?: string
  quality?: string
  qualityLabel?: string
  name?: string
  level?: number
}

interface LiveStream {
  living?: boolean
  caption?: string
  poster?: string
  coverUrl?: string
  playUrls?: PlayUrl[]
  adaptationSet?: { representation?: Represent[] }
  user?: { name?: string; headUrl?: string; avatar?: string }
}

interface DetailResp {
  result?: number
  data?: {
    liveStream?: LiveStream
    author?: { name?: string; headurl?: string; avatar?: string }
    user?: { name?: string; headUrl?: string }
  }
}

async function detail(principalId: string, ctx: ProviderContext): Promise<DetailResp> {
  const res = await request(`${DETAIL_API}?principalId=${encodeURIComponent(principalId)}`, {
    cookie: ctx.cookie,
    referer: DEFAULT_REFERER.kuaishou,
    headers: { Accept: 'application/json, text/plain, */*' }
  })
  const text = res.text?.trim() ?? ''
  if (!text) throw new Error(`快手接口无返回（HTTP ${res.status}）`)
  try {
    return JSON.parse(text) as DetailResp
  } catch {
    throw new Error('快手接口返回的不是 JSON，通常是缺少 Cookie 被重定向到了登录页')
  }
}

/** 业务码不为 0 时给出人话解释 */
function assertOk(j: DetailResp, ctx: ProviderContext): LiveStream {
  const ls = j?.data?.liveStream
  if (ls) return ls
  const code = j?.result
  if (code === 400002 || code === 400003) {
    throw new Error(
      ctx.cookie
        ? '快手接口拒绝了当前 Cookie（did / api_ph 可能已过期），请重新复制一次'
        : '快手需要 Cookie 才能读取房间信息，请到「设置 → 平台 Cookie」填入'
    )
  }
  throw new Error(code != null ? `快手接口返回错误码 ${code}` : '快手未返回直播间数据')
}

function pickAvatar(ls: LiveStream, j: DetailResp): string | undefined {
  return (
    ls.user?.headUrl ||
    ls.user?.avatar ||
    j.data?.author?.headurl ||
    j.data?.author?.avatar ||
    j.data?.user?.headUrl
  )
}

function pickAnchor(ls: LiveStream, j: DetailResp): string {
  return String(ls.user?.name ?? j.data?.author?.name ?? j.data?.user?.name ?? '')
}

export const kuaishouProvider: LiveProvider = {
  id: 'kuaishou',
  name: '快手',
  danmakuSupported: false,

  parseRoomId(input: string): string | null {
    const s = input.trim()
    if (/^\d+$/.test(s)) return s
    // principalId 是字母数字混合串（如 3x7zjr8qbrjbwxs），直接粘 ID 也要认
    if (/^[A-Za-z0-9_-]{6,}$/.test(s)) return s
    // https://live.kuaishou.com/u/<principalId>
    const m1 = /live\.kuaishou\.com\/u\/([A-Za-z0-9_-]+)/i.exec(s)
    if (m1) return m1[1]
    // https://v.kuaishou.com/xxxx 短链无法在本地展开，交给界面提示
    const m2 = /kuaishou\.com\/profile\/([A-Za-z0-9_-]+)/i.exec(s)
    if (m2) return m2[1]
    return null
  },

  async getRoomInfo(principalId: string, ctx: ProviderContext): Promise<RoomInfo> {
    const j = await detail(principalId, ctx)
    const ls = assertOk(j, ctx)
    return {
      platform: 'kuaishou',
      roomId: principalId,
      title: String(ls.caption ?? ''),
      anchor: pickAnchor(ls, j),
      avatar: pickAvatar(ls, j),
      cover: ls.poster || ls.coverUrl,
      live: ls.living === true
    }
  },

  async getStreams(principalId: string, ctx: ProviderContext): Promise<StreamVariant[]> {
    const j = await detail(principalId, ctx)
    const ls = assertOk(j, ctx)
    if (ls.living !== true) throw new Error('主播当前未开播')

    const headers = { 'User-Agent': ctx.ua, Referer: DEFAULT_REFERER.kuaishou! }
    const out: StreamVariant[] = []

    // 形态一：playUrls（大多数情况）
    for (const p of ls.playUrls ?? []) {
      if (!p.url) continue
      const label = p.qualityLabel || p.name || p.quality || '默认'
      out.push({
        quality: label,
        label: `${label} · ${guessFormat(p.url)}`,
        url: p.url,
        format: guessFormat(p.url),
        headers
      })
    }

    // 形态二：adaptationSet.representation
    for (const r of ls.adaptationSet?.representation ?? []) {
      if (!r.url) continue
      const label = r.qualityLabel || r.name || (r.level != null ? `level ${r.level}` : '默认')
      out.push({
        quality: label,
        label: `${label} · ${guessFormat(r.url)}`,
        url: r.url,
        format: guessFormat(r.url),
        headers
      })
    }

    if (!out.length) {
      throw new Error('快手未返回任何流地址（可能需要在浏览器打开一次直播间以刷新 Cookie）')
    }
    // 高码率优先
    return dedupe(out)
  },

  createDanmaku(): never {
    // 快手弹幕同样是私有 wss 协议（wss://live.kuaishou.com/websocket），
    // 需要 did + 签名，暂未实现。
    throw new NotImplementedError('快手弹幕')
  }
}

function guessFormat(url: string): StreamVariant['format'] {
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls'
  if (/\.flv(\?|$)/i.test(url)) return 'flv'
  if (/\.mp4(\?|$)/i.test(url)) return 'mp4'
  return 'flv'
}

/** 去重：同一 url 只保留第一条；同时把 hls 排在 flv 前面 */
function dedupe(list: StreamVariant[]): StreamVariant[] {
  const seen = new Set<string>()
  const out: StreamVariant[] = []
  for (const v of list) {
    const key = v.url.split('?')[0]
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out.sort((a, b) => (a.format === b.format ? 0 : a.format === 'hls' ? -1 : 1))
}
