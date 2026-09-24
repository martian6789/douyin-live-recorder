import zlib from 'node:zlib'
import type { RoomInfo, StreamVariant } from '../../shared/types'
import type {
  DanmakuClient,
  DanmakuHandlers,
  DanmakuPayload,
  LiveProvider,
  ProviderContext
} from './types'
import { intToHexColor } from './types'
import { DEFAULT_REFERER, pickCookie, randomBuvid, request } from './http'

const API = 'https://api.live.bilibili.com'

/** B 站清晰度档位 → 中文名 */
const QN_LABEL: Record<number, string> = {
  10000: '原画',
  20000: '4K',
  401: '杜比',
  400: '蓝光',
  250: '超清',
  150: '高清',
  80: '流畅'
}

/* ----------------------------- 弹幕协议 ----------------------------- */

const OP_HEARTBEAT = 2
const OP_MESSAGE = 5
const OP_AUTH = 1
const OP_AUTH_REPLY = 8

/** 简单 WebSocket 结构，避免依赖 @types 版本差异 */
interface WSLike {
  binaryType: string
  onopen: ((ev: any) => void) | null
  onmessage: ((ev: any) => void) | null
  onerror: ((ev: any) => void) | null
  onclose: ((ev: any) => void) | null
  send: (data: any) => void
  close: () => void
}

function encodePacket(op: number, body: Buffer | string): Buffer {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  const header = Buffer.alloc(16)
  header.writeUInt32BE(payload.length + 16, 0)
  header.writeUInt16BE(16, 4)
  header.writeUInt16BE(1, 6) // protover: 1 = 明文 JSON
  header.writeUInt32BE(op, 8)
  header.writeUInt32BE(1, 12) // sequence
  return Buffer.concat([header, payload])
}

/**
 * 解出一串缓冲区里的所有逻辑包；protover 2/3 时递归解内层。
 * 返回已消费的字节数，调用方用 subarray 保留不足一包的残留（TCP/WebSocket 粘包场景）。
 */
function decodePackets(buf: Buffer): { packets: { op: number; body: Buffer }[]; consumed: number } {
  const out: { op: number; body: Buffer }[] = []
  let offset = 0
  while (offset + 16 <= buf.length) {
    const packetLen = buf.readUInt32BE(offset)
    // 包长非法或数据还没收全 —— 等下一次消息
    if (packetLen < 16 || offset + packetLen > buf.length) break
    const headerLen = buf.readUInt16BE(offset + 4)
    const protover = buf.readUInt16BE(offset + 6)
    const op = buf.readUInt32BE(offset + 8)
    const body = buf.subarray(offset + headerLen, offset + packetLen)
    offset += packetLen

    if (protover === 2) {
      try {
        const inner = decodePackets(zlib.inflateSync(body as any) as Buffer)
        out.push(...inner.packets)
        continue
      } catch {
        /* 解压失败则按明文处理 */
      }
    } else if (protover === 3) {
      try {
        const inner = decodePackets(zlib.brotliDecompressSync(body as any) as Buffer)
        out.push(...inner.packets)
        continue
      } catch {
        /* ignore */
      }
    }
    out.push({ op, body })
  }
  return { packets: out, consumed: offset }
}

interface BiliDanmakuRaw {
  cmd: string
  info?: any[]
  data?: any
}

/** 把 B 站的 cmd 消息转成统一弹幕结构；返回 null 表示不关心 */
function normalize(raw: BiliDanmakuRaw, roomId: string): DanmakuPayload | null {
  const base = { platform: 'bilibili' as const, roomId }

  switch (raw.cmd) {
    case 'DANMU_MSG': {
      const info = raw.info || []
      const meta = Array.isArray(info[0]) ? info[0] : []
      const userArr = Array.isArray(info[2]) ? info[2] : []
      const text = String(info[1] ?? '')
      if (!text) return null
      return {
        ...base,
        type: 'chat',
        user: String(userArr[1] ?? ''),
        uid: String(userArr[0] ?? ''),
        text,
        color: intToHexColor(Number(meta[3] ?? 16777215))
      }
    }
    case 'SEND_GIFT': {
      const d = raw.data || {}
      const coin = Number(d.total_coin ?? 0)
      return {
        ...base,
        type: 'gift',
        user: String(d.uname ?? ''),
        uid: String(d.uid ?? ''),
        text: `送出 ${d.giftName ?? '礼物'} ×${d.num ?? 1}`,
        giftName: String(d.giftName ?? ''),
        giftCount: Number(d.num ?? 1),
        // 金瓜子 1000 = 1 元；银瓜子不计价
        giftValue: d.coin_type === 'gold' ? coin / 1000 : 0
      }
    }
    case 'SUPER_CHAT_MESSAGE':
    case 'SUPER_CHAT_MESSAGE_JPN': {
      const d = raw.data || {}
      return {
        ...base,
        type: 'superchat',
        user: String(d.user_info?.uname ?? d.uname ?? ''),
        uid: String(d.uid ?? ''),
        text: String(d.message ?? ''),
        giftName: '醒目留言',
        giftValue: Number(d.price ?? 0)
      }
    }
    case 'INTERACT_WORD': {
      const d = raw.data || {}
      return {
        ...base,
        type: 'enter',
        user: String(d.uname ?? ''),
        uid: String(d.uid ?? ''),
        text: '进入直播间'
      }
    }
    case 'LIKE_INFO_V3_CLICK': {
      const d = raw.data || {}
      return {
        ...base,
        type: 'like',
        user: String(d.uname ?? ''),
        uid: String(d.uid ?? ''),
        text: String(d.like_text ?? '为主播点赞')
      }
    }
    default:
      return null
  }
}

/* ----------------------------- Provider 实现 ----------------------------- */

export const bilibiliProvider: LiveProvider = {
  id: 'bilibili',
  name: '哔哩哔哩',
  danmakuSupported: true,

  parseRoomId(input: string): string | null {
    const s = input.trim()
    if (/^\d+$/.test(s)) return s
    const m = /live\.bilibili\.com\/(?:blanc\/)?(\d+)/i.exec(s)
    return m ? m[1] : null
  },

  async getRoomInfo(roomId: string, ctx: ProviderContext): Promise<RoomInfo> {
    const cookie = ensureCookie(ctx.cookie)
    const referer = `${DEFAULT_REFERER.bilibili}${roomId}`

    const res = await request(`${API}/room/v1/Room/get_info?room_id=${roomId}`, {
      cookie,
      referer: DEFAULT_REFERER.bilibili
    })
    const j = res.json<any>()
    if (j.code !== 0 || !j.data) throw new Error(j.message || '获取房间信息失败')
    const d = j.data

    // 主播名需要额外一次请求，失败不影响主流程
    let anchor = ''
    try {
      const b = await request(
        // 注意：参数必须是 room_ids=xxx，写成 room_ids[]=xxx 会返回空对象
        `${API}/xlive/web-room/v1/index/getRoomBaseInfo?room_ids=${roomId}&req_biz=web`,
        { cookie, referer }
      ).then((r) => r.json<any>())
      anchor = b?.data?.by_room_ids?.[String(roomId)]?.uname ?? ''
    } catch {
      /* ignore */
    }

    return {
      platform: 'bilibili',
      roomId: String(d.room_id ?? roomId),
      title: String(d.title ?? ''),
      anchor,
      cover: d.user_cover || d.keyframe || undefined,
      live: Number(d.live_status) === 1,
      audience: Number(d.online ?? 0),
      startedAt: d.live_time ? Number(d.live_time) * 1000 : undefined
    }
  },

  async getStreams(roomId: string, ctx: ProviderContext): Promise<StreamVariant[]> {
    const cookie = ensureCookie(ctx.cookie)
    const url =
      `${API}/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${roomId}` +
      `&no_playurl=0&mask=1&qn=0&platform=web&protocol=0,1&format=0,1,2&codec=0,1&dolby=0&hdr=0&ptype=8`
    const res = await request(url, { cookie, referer: `${DEFAULT_REFERER.bilibili}${roomId}` })
    const j = res.json<any>()
    if (j.code !== 0) throw new Error(j.message || '获取播放地址失败（可能需要 Cookie）')

    const streams = j?.data?.playurl_info?.playurl?.stream
    if (!Array.isArray(streams) || streams.length === 0) {
      throw new Error('没有可用的播放地址，确认主播是否在播，或补充 Cookie 后重试')
    }

    const out: StreamVariant[] = []
    for (const st of streams) {
      const isHls = st.protocol_name === 'http_hls'
      for (const fmt of st.format || []) {
        for (const codec of fmt.codec || []) {
          const first = (codec.url_info || [])[0]
          if (!first?.host || !codec.base_url) continue
          const full = `${first.host}${codec.base_url}${first.extra ?? ''}`
          const qn = Number(codec.current_qn ?? 80)
          out.push({
            quality: String(qn),
            label: `${QN_LABEL[qn] ?? qn} · ${isHls ? 'HLS' : 'FLV'}`,
            url: full,
            format: isHls ? 'hls' : 'flv',
            headers: {
              'User-Agent': ctx.ua,
              Referer: DEFAULT_REFERER.bilibili!,
              Origin: 'https://live.bilibili.com'
            }
          })
        }
      }
    }

    // 同清晰度去重，按清晰度从高到低
    const seen = new Set<string>()
    return out
      .filter((v) => (seen.has(v.quality + v.format) ? false : (seen.add(v.quality + v.format), true)))
      .sort((a, b) => Number(b.quality) - Number(a.quality))
  },

  createDanmaku(roomId: string, ctx: ProviderContext, h: DanmakuHandlers): DanmakuClient {
    let ws: WSLike | null = null
    let hb: NodeJS.Timeout | null = null
    let closed = false

    const cleanup = () => {
      if (hb) {
        clearInterval(hb)
        hb = null
      }
    }

    const fail = (e: Error) => {
      if (closed) return
      cleanup()
      h.onError?.(e)
      h.onStatus?.('closed')
    }

    ;(async () => {
      try {
        h.onStatus?.('connecting')
        const cookie = ensureCookie(ctx.cookie)
        const infoRes = await request(
          `${API}/xlive/web-room/v1/index/getDanmuInfo?id=${roomId}&type=0`,
          { cookie, referer: `${DEFAULT_REFERER.bilibili}${roomId}` }
        )
        const j = infoRes.json<any>()
        const token: string | undefined = j?.data?.token
        const host = (j?.data?.host_list || [])[0]
        if (j?.code !== 0 || !token || !host?.host) {
          // -352 是风控码：没有登录态 Cookie 时会直接拒绝发放弹幕服务器
          if (j?.code === -352) {
            throw new Error('B 站风控拦截（-352）：请在「设置 → 平台 Cookie」填入 B 站 Cookie 后重试')
          }
          throw new Error(j?.message ? `获取弹幕服务器失败（${j.message}）` : '获取弹幕服务器失败')
        }

        const port = host.wss_port || host.ws_port || 443
        const WS = (globalThis as any).WebSocket
        if (!WS) throw new Error('当前 Node 版本不支持全局 WebSocket')

        const socket: WSLike = new WS(`wss://${host.host}:${port}/sub`)
        socket.binaryType = 'arraybuffer'
        let pending: Buffer = Buffer.alloc(0)

        socket.onopen = () => {
          socket.send(
            encodePacket(
              OP_AUTH,
              JSON.stringify({
                uid: 0,
                roomid: Number(roomId),
                protover: 2,
                platform: 'web',
                clientver: '2.0.0',
                type: 2,
                key: token
              })
            )
          )
          // 心跳间隔 30s，body 沿用官方客户端的 "[object Object]"
          hb = setInterval(() => {
            try {
              socket.send(encodePacket(OP_HEARTBEAT, '[object Object]'))
            } catch {
              /* ignore */
            }
          }, 30000)
        }

        socket.onmessage = (ev: any) => {
          if (closed) return
          let chunk: Buffer
          const data = ev.data
          if (data instanceof ArrayBuffer) chunk = Buffer.from(new Uint8Array(data))
          else if (Buffer.isBuffer(data)) chunk = data
          else if (data instanceof Uint8Array) chunk = Buffer.from(data)
          else return
          pending = Buffer.concat([pending, chunk])

          const { packets, consumed } = decodePackets(pending)
          if (packets.length === 0) return
          // 保留不足一包的残留，避免半包被丢弃导致后续解析错乱
          pending = Buffer.from(pending.subarray(consumed))

          for (const p of packets) {
            if (p.op === OP_AUTH_REPLY) {
              h.onStatus?.('open')
              continue
            }
            if (p.op !== OP_MESSAGE) continue
            const text = p.body.toString('utf8')
            let raw: BiliDanmakuRaw
            try {
              raw = JSON.parse(text)
            } catch {
              continue
            }
            const msg = normalize(raw, roomId)
            if (msg) h.onMessage(msg)
          }
        }

        socket.onerror = () => fail(new Error('弹幕连接出错'))
        socket.onclose = () => {
          if (closed) return
          cleanup()
          h.onStatus?.('closed')
        }

        ws = socket
      } catch (e: any) {
        fail(e instanceof Error ? e : new Error(String(e)))
      }
    })()

    return {
      close() {
        closed = true
        cleanup()
        try {
          ws?.close()
        } catch {
          /* ignore */
        }
        h.onStatus?.('closed')
      }
    }
  }
}

/** B 站风控：没有 buvid3 时自动补一个，否则拿不到播放地址 */
function ensureCookie(cookie: string | undefined): string {
  if (pickCookie(cookie, 'buvid3')) return cookie as string
  const b3 = randomBuvid()
  const b4 = `buvid4=${randomBuvid()}`
  return cookie ? `${cookie}; buvid3=${b3}; ${b4}` : `buvid3=${b3}; ${b4}`
}
