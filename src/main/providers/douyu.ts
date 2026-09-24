import { createHash } from 'node:crypto'
import type { RoomInfo, StreamVariant } from '../../shared/types'
import type {
  DanmakuClient,
  DanmakuHandlers,
  DanmakuPayload,
  LiveProvider,
  ProviderContext
} from './types'
import { DEFAULT_REFERER, request } from './http'

/* ------------------------- 斗鱼弹幕协议（STT 序列化） ------------------------- */
/**
 * 重要：旧的 `openbarrage.douyutv.com:8601`（TCP）已下线，域名解析都不通。
 * 现役网关是 `wss://danmuproxy.douyu.com:8506/`，**消息帧格式与 STT 序列化完全不变**，
 * 只是传输层从裸 TCP 换成了 WebSocket（每帧 = 4B len + 4B len + 2B type + 1B enc + 1B resv + body\0）。
 */
const DANMAKU_WS = 'wss://danmuproxy.douyu.com:8506/'
const MSG_TYPE = 689

/** 预览接口用的固定设备 ID（斗鱼公开示例值，随机值会被拒） */
const PREVIEW_DID = '10000000000000000000000000001501'
const PREVIEW_API = 'https://playweb.douyucdn.cn/lapi/live/hlsH5Preview'

/** 路线一（预览通道）的失败原因，拼进最终报错里便于定位 */
let previewFail = ''

/** STT 反序列化：`key@=value/` 分隔，`@S`→`/`，`@A`→`@` */
function sttDecode(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of s.split('/')) {
    const i = part.indexOf('@=')
    if (i < 0) continue
    const k = part.slice(0, i)
    const v = part.slice(i + 2).replace(/@S/g, '/').replace(/@A/g, '@')
    out[k] = v
  }
  return out
}

function sttEncode(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${k}@=${String(v).replace(/@/g, '@A').replace(/\//g, '@S')}/`)
    .join('')
}

/** 打包一条斗鱼消息：12 字节头 + 正文（以 \0 结尾） */
function pack(obj: Record<string, string>): Buffer {
  const body = Buffer.from(sttEncode(obj) + '\0', 'utf8')
  const len = 12 + body.length
  const buf = Buffer.alloc(len)
  buf.writeUInt32LE(len, 0)
  buf.writeUInt32LE(len, 4)
  buf.writeUInt16LE(MSG_TYPE, 8)
  buf.writeUInt8(0, 10) // encrypt
  buf.writeUInt8(0, 11) // reserved
  body.copy(buf, 12)
  return buf
}

const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex')

/** 常见礼物 ID → 名称；未收录的显示 ID */
const GIFT_NAME: Record<string, string> = {
  '824': '荧光棒',
  '519': '天使翅膀',
  '268': '鱼丸',
  '192': '赞',
  '193': '弱鸡',
  '824.1': '荧光棒'
}

function normalizeDouyu(f: Record<string, string>, roomId: string): DanmakuPayload | null {
  const base = { platform: 'douyu' as const, roomId }
  const uname = f.nn ?? ''
  const uid = f.uid ?? ''

  switch (f.type) {
    case 'chatmsg': {
      const text = (f.txt ?? '').trim()
      if (!text) return null
      return { ...base, type: 'chat', user: uname, uid, text, color: f.col ? `#${f.col}` : undefined }
    }
    case 'dgb': {
      const gfid = f.gfid ?? ''
      const name = GIFT_NAME[gfid] ?? `礼物${gfid}`
      return {
        ...base,
        type: 'gift',
        user: uname,
        uid,
        text: `送出 ${name} ×${f.gfcnt ?? 1}`,
        giftName: name,
        giftCount: Number(f.gfcnt ?? 1),
        giftValue: Number(f.gfcost ?? 0) / 100
      }
    }
    case 'uenter':
      return { ...base, type: 'enter', user: uname, uid, text: '进入直播间' }
    default:
      return null
  }
}

/* ----------------------------- Provider 实现 ----------------------------- */

export const douyuProvider: LiveProvider = {
  id: 'douyu',
  name: '斗鱼',
  danmakuSupported: true,

  parseRoomId(input: string): string | null {
    const s = input.trim()
    if (/^\d+$/.test(s)) return s
    const m = /douyu\.com\/(\d+)/i.exec(s)
    return m ? m[1] : null
  },

  async getRoomInfo(roomId: string, ctx: ProviderContext): Promise<RoomInfo> {
    const res = await request(`https://www.douyu.com/betard/${roomId}`, {
      cookie: ctx.cookie,
      referer: `https://www.douyu.com/${roomId}`
    })
    const j = res.json<any>()
    const room = j?.room
    if (!room) throw new Error('房间不存在或接口变更')
    return {
      platform: 'douyu',
      roomId: String(room.room_id ?? roomId),
      title: String(room.room_name ?? ''),
      anchor: String(room.owner_name ?? room.nickname ?? ''),
      cover: room.room_pic || room.avatar || undefined,
      // 字段改版：betard 现在只返回 status / show_status，老的 room_status 已不再下发，
      // 仍按老字段解析会把所有房间都判成「未开播」。
      live: Number(room.status ?? room.show_status ?? room.room_status) === 1,
      audience: Number(room.hn ?? room.iol ?? 0)
    }
  },

  async getStreams(roomId: string, ctx: ProviderContext): Promise<StreamVariant[]> {
    const headers = { 'User-Agent': ctx.ua, Referer: DEFAULT_REFERER.douyu! }

    // 路线一（现行可用）：hlsH5Preview。只需 md5(rid + 毫秒时间戳) 做 auth，
    // 不需要执行页面里的 ub98484234 签名脚本，稳定得多。
    try {
      const t13 = String(Date.now())
      const res = await request(`${PREVIEW_API}/${roomId}`, {
        method: 'POST',
        cookie: ctx.cookie,
        referer: `https://www.douyu.com/${roomId}`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          rid: roomId,
          time: t13,
          auth: md5(roomId + t13)
        },
        body: new URLSearchParams({ rid: roomId, did: PREVIEW_DID }).toString()
      })
      const j = res.json<any>()
      if (Number(j.error) === 0 && j.data?.rtmp_url && j.data?.rtmp_live) {
        return [
          {
            quality: '0',
            label: '默认 · HLS',
            url: `${j.data.rtmp_url}/${j.data.rtmp_live}`,
            format: 'hls',
            headers
          }
        ]
      }
      // error 非 0：把业务码带出来，便于定位
      if (Number(j.error) !== 0) throw new Error(String(j.msg ?? `预览接口错误 ${j.error}`))
    } catch (e: any) {
      // 路线一失败则继续尝试路线二
      previewFail = e?.message ?? String(e)
    }

    // 路线二（历史接口）：现在需要 ub98484234 签名，无签名时返回「鉴权失败 / 时间戳错误」。
    // 保留是为了将来签名实现后能直接生效。
    const did = randomHex(32)
    const cookie = ctx.cookie ? `${ctx.cookie}; dy_did=${did}` : `dy_did=${did}`
    const res = await request(`https://www.douyu.com/lapi/live/getH5Play/${roomId}`, {
      cookie,
      referer: `https://www.douyu.com/${roomId}`
    })
    const j = res.json<any>()
    if (Number(j.error) !== 0 || !j.data) {
      throw new Error(`未开播或没有可用线路${previewFail ? `（预览通道：${previewFail}）` : ''}`)
    }
    const d = j.data
    if (!d.rtmp_url || !d.rtmp_live) throw new Error('未开播或没有可用线路')

    const url = `${d.rtmp_url}/${d.rtmp_live}`
    const out: StreamVariant[] = [
      {
        quality: '0',
        label: '默认 · HLS',
        url,
        format: 'hls',
        headers: { 'User-Agent': ctx.ua, Referer: DEFAULT_REFERER.douyu! }
      }
    ]
    // 多清晰度：斗鱼通过 multirates 给出，替换流名里的清晰度位
    for (const r of (d.multirates || []) as any[]) {
      out.push({
        quality: String(r.rate),
        label: `${r.name ?? '线路' + r.rate} · HLS`,
        url: url.replace(/^(\S+?)(\d+)(\.m3u8.*)$/, (_, a, _b, c) => `${a}${r.rate}${c}`),
        format: 'hls',
        headers: { 'User-Agent': ctx.ua, Referer: DEFAULT_REFERER.douyu! }
      })
    }
    return out
  },

  createDanmaku(roomId: string, _ctx: ProviderContext, h: DanmakuHandlers): DanmakuClient {
    let ws: any = null
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

    h.onStatus?.('connecting')

    const connect = () => {
      try {
        const WS = (globalThis as any).WebSocket
        if (!WS) throw new Error('当前运行环境不支持 WebSocket')

        const socket: any = new WS(DANMAKU_WS)
        socket.binaryType = 'arraybuffer'

        socket.onopen = () => {
          socket.send(pack({ type: 'loginreq', roomid: roomId }))
          socket.send(pack({ type: 'joingroup', rid: roomId, gid: '-9999' }))
          // 心跳必须小于 45s
          hb = setInterval(() => {
            try {
              socket.send(pack({ type: 'mrkl' }))
            } catch {
              /* ignore */
            }
          }, 30000)
          h.onStatus?.('open')
        }

        socket.onmessage = (ev: any) => {
          if (closed) return
          let chunk: Buffer
          const data = ev.data
          if (data instanceof ArrayBuffer) chunk = Buffer.from(new Uint8Array(data))
          else if (Buffer.isBuffer(data)) chunk = data
          else if (typeof data === 'string') chunk = Buffer.from(data, 'utf8')
          else return

          for (;;) {
            if (chunk.length < 12) break
            const len = chunk.readUInt32LE(0)
            if (len < 12 || chunk.length < len) break
            const body = chunk.subarray(12, len).toString('utf8').replace(/\0+$/, '')
            chunk = chunk.subarray(len)
            if (!body) continue
            try {
              const f = sttDecode(body)
              if (!f.type) continue
              const msg = normalizeDouyu(f, roomId)
              if (msg) h.onMessage(msg)
            } catch {
              /* 忽略无法解析的帧 */
            }
          }
        }

        // 网关偶发握手失败（实测约 1/3 概率）：这里**不**自己重连。
        // 重连交给 danmaku-hub（带 2s→30s 退避、最多 10 次），
        // 否则 onerror / onclose 成对触发时会互相放大成重连风暴。
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
    }

    connect()

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

function randomHex(n: number): string {
  const chars = '0123456789abcdef'
  let s = ''
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * 16)]
  return s
}
