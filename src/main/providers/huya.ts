import type { RoomInfo, StreamVariant } from '../../shared/types'
import type { LiveProvider, ProviderContext } from './types'
import { NotImplementedError } from './types'
import { request } from './http'

/**
 * 虎牙：没有稳定的公开直播 API，采用「页面解析」路线。
 * 直播间 HTML 里内联了 window.HNF_GLOBAL_INIT，其中包含房间信息与流参数。
 */
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/**
 * 虎牙页面字段几经改版：桌面页现在只剩 `nick` / `screenshot` / `sTitle`，
 * 移动端页还保留着老的 `sNick` / `sRoomName` / `lTotalCount`。
 * 因此**移动端页优先、桌面页兜底**，两边字段都试一遍，取到哪个用哪个。
 */
async function fetchPage(roomId: string, ctx: ProviderContext): Promise<string> {
  const candidates = [
    { url: `https://m.huya.com/${roomId}`, ua: MOBILE_UA },
    { url: `https://www.huya.com/${roomId}`, ua: ctx.ua }
  ]
  let lastErr: unknown = null
  for (const c of candidates) {
    try {
      const res = await request(c.url, {
        cookie: ctx.cookie,
        referer: c.url,
        headers: { 'User-Agent': c.ua }
      })
      if (res.text && res.text.length > 1000) return res.text
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('虎牙页面请求失败')
}

/** 从 HTML 里抓 "key":"value" 形态的字段 */
function pick(html: string, key: string): string | null {
  const m = new RegExp(`"?${key}"?\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(html)
  if (!m) return null
  return m[1].replace(/\\u002F/gi, '/').replace(/\\"/g, '"')
}

/** 依次尝试多个 key，返回第一个非空值 */
function pickAny(html: string, keys: string[]): string {
  for (const k of keys) {
    const v = pick(html, k)
    if (v && v.trim()) return v.trim()
  }
  return ''
}

/** 依次尝试多个数字型 key */
function pickNum(html: string, keys: string[]): number | undefined {
  for (const k of keys) {
    const m = new RegExp(`"?${k}"?\\s*:\\s*(\\d+)`).exec(html)
    if (m) return Number(m[1])
  }
  return undefined
}

/** 兜底：从 <title> 里还原房间标题（形如「主播_房间名_分区_虎牙直播」） */
function titleFromTag(html: string): string {
  const t = /<title>([^<]*)<\/title>/.exec(html)
  if (!t) return ''
  const parts = t[1].split('_').map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) return ''
  // 有 2 段以上时第 2 段是房间名；只有 1 段就用它自己
  return parts.length >= 2 ? parts[1] : parts[0]
}

export const huyaProvider: LiveProvider = {
  id: 'huya',
  name: '虎牙',
  danmakuSupported: false,

  parseRoomId(input: string): string | null {
    const s = input.trim()
    if (/^\d+$/.test(s)) return s
    const m = /huya\.com\/(\d+)/i.exec(s)
    return m ? m[1] : null
  },

  async getRoomInfo(roomId: string, ctx: ProviderContext): Promise<RoomInfo> {
    const html = await fetchPage(roomId, ctx)
    const title = pickAny(html, ['sTitle', 'sRoomName', 'liveRoomName', 'roomName']) || titleFromTag(html)
    const anchor = pickAny(html, ['sNick', 'nick', 'sAnchorName', 'anchorName'])
    if (!title && !anchor) throw new Error('页面解析失败，可能接口变更或需要 Cookie')

    return {
      platform: 'huya',
      roomId,
      title,
      anchor,
      cover: pickAny(html, ['sScreenshot', 'screenshot', 'sLivePic']) || undefined,
      // 有流名即视为在播
      live: !!pickAny(html, ['sStreamName']) || pickNum(html, ['eLiveStatus']) === 1,
      audience: pickNum(html, ['lTotalCount', 'totalCount', 'lUserCount', 'attendeeCount'])
    }
  },

  async getStreams(roomId: string, ctx: ProviderContext): Promise<StreamVariant[]> {
    const html = await fetchPage(roomId, ctx)
    const streamName = pick(html, 'sStreamName')
    if (!streamName) throw new Error('未开播或页面结构变更')

    const out: StreamVariant[] = []
    const headers = { 'User-Agent': ctx.ua, Referer: 'https://www.huya.com/' }

    const hlsUrl = pick(html, 'sHlsUrl')
    const hlsAnti = pick(html, 'sHlsAntiCode') ?? ''
    if (hlsUrl) {
      out.push({
        quality: 'hls',
        label: '默认 · HLS',
        url: `${hlsUrl}/${streamName}.m3u8?${hlsAnti}`,
        format: 'hls',
        headers
      })
    }

    const flvUrl = pick(html, 'sFlvUrl')
    const flvAnti = pick(html, 'sFlvAntiCode') ?? ''
    if (flvUrl) {
      out.push({
        quality: 'flv',
        label: '默认 · FLV',
        url: `${flvUrl}/${streamName}.flv?${flvAnti}`,
        format: 'flv',
        headers
      })
    }

    if (out.length === 0) throw new Error('页面里没有找到流地址')
    return out
  },

  createDanmaku(): never {
    throw new NotImplementedError('虎牙弹幕')
  }
}
