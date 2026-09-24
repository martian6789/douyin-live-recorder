/**
 * 本地流中继（内置播放器预览用）。
 *
 * 为什么需要它：各平台的拉流地址几乎都校验 Referer / UA / Cookie，
 * 渲染进程里的 <video> 没法自定义这些请求头，直接播必然 403。
 * 做法是在 127.0.0.1 上开一个小 HTTP 服务，由主进程带着正确请求头去取流，
 * 再把字节流原样转给渲染进程 —— 播放器只看到 http://127.0.0.1:xxx/...，不存在跨域问题。
 *
 * 只监听回环地址，不对外暴露；进程退出即销毁。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { spawn, type ChildProcess } from 'node:child_process'
import { log } from './logger'
import { requireFfmpeg, buildPreviewTranscodeArgs } from './ffmpeg'
import type { StreamVariant } from '../shared/types'

const L = log('relay')

let server: http.Server | null = null
let port = 0
/** 已打开的连接，退出时统一断开，避免进程挂住 */
const sockets = new Set<import('node:net').Socket>()

/* ------------------------------------------------------------------ *
 * 弹幕回传通道（/dm）：
 * 抖音弹幕跑在隐藏的 Chromium 窗口里（真实浏览器指纹才能过抖音风控），
 * 窗口里解出的弹幕用 HTTP POST 打到这个本地端点，再由这里分发给订阅者。
 * 只监听回环地址，与 /proxy 同一台小服务器。
 * ------------------------------------------------------------------ */
type DmSink = (msg: unknown) => void
const dmSinks = new Map<string, DmSink>()

export function registerDanmakuSink(room: string, cb: DmSink): void {
  dmSinks.set(room, cb)
}
export function unregisterDanmakuSink(room: string): void {
  dmSinks.delete(room)
}

/** 弹幕窗口页面（由 danmaku-douyin 注入，经 /dm-page 提供给隐藏 Chromium 窗口） */
let dmPageHtml = ''
export function setDmPage(html: string): void {
  dmPageHtml = html
}

async function handleDm(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  cors(res)
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
  const room = url.searchParams.get('room') || ''
  const sink = dmSinks.get(room)
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (sink && body) {
      try {
        sink(JSON.parse(body))
      } catch {
        /* 单条坏数据不影响整体 */
      }
    }
    res.writeHead(204).end()
  })
}

/** 只允许代理这些域名的流，防止被当成通用代理 */
const ALLOW_HOSTS = [
  'bilivideo.com',
  'bilivideo.cn',
  'hdslb.com',
  'acgvideo.com',
  'douyucdn.cn',
  'douyucdn2.cn',
  'douyu.com',
  'huya.com',
  'huyacdn.com',
  'douyin.com',
  'douyincdn.com',
  'douyinliving.com', // 抖音直播拉流 CDN，HLS/FLV 分片流常用
  'douyinpic.com',
  'zjcdn.com',
  'bytecdn.cn',
  'byteimg.com',
  'ibytedtos.com',
  'pstatp.com',
  'kuaishou.com',
  'kwimgs.com',
  'kwaicdn.com',
  'yximgs.com',
  'chenzhongtech.com',
  'gifshow.com',
  'ksyun.com',
  'live-play.acgvideo.com'
]

/** 抖音拉流 CDN 对 Chrome UA 风控严、对 Lavf UA 宽容。
 *  现象：recorder（ffmpeg 直连，Lavf UA）能拉到流，但 relay（Chrome UA）拿 403。
 *  修法：中继转发抖音相关域名时改用 Lavf UA，绕过上游 CDN 的浏览器风控。 */
const FFMPEG_UA = 'Lavf/62.0.106'
const DEFAULT_FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const USE_LAVF_UA_HOSTS = ['douyinliving.com', 'douyincdn.com']

function hostMatch(h: string, suffixes: string[]): boolean {
  const x = h.toLowerCase()
  return suffixes.some((s) => x === s || x.endsWith(`.${s}`))
}

function pickUA(host: string): string {
  return hostMatch(host, USE_LAVF_UA_HOSTS) ? FFMPEG_UA : DEFAULT_FETCH_UA
}

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase()
  return ALLOW_HOSTS.some((a) => h === a || h.endsWith(`.${a}`))
}

function cors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Expose-Headers', '*')
}

function encodeProxyQuery(
  url: string,
  referer: string,
  cookie?: string,
  headers?: Record<string, string>
): string {
  const p = new URLSearchParams()
  p.set('u', url)
  if (referer) p.set('r', referer)
  if (cookie) p.set('c', cookie)
  if (headers && Object.keys(headers).length) {
    p.set('h', Buffer.from(JSON.stringify(headers)).toString('base64'))
  }
  return p.toString()
}

/** m3u8 里的分片地址要改写成同样走中继 */
function rewritePlaylist(
  body: string,
  baseUrl: string,
  referer: string,
  cookie: string,
  headers: Record<string, string>
): string {
  const base = new URL(baseUrl)
  return body
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim()
      if (!t) return line
      // 标签行里夹的 URI="..." （如 #EXT-X-KEY）
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_m, u: string) => {
          const abs = new URL(u, base).toString()
          return `URI="/proxy?${encodeProxyQuery(abs, referer, cookie, headers)}"`
        })
      }
      const abs = new URL(t, base).toString()
      return `/proxy?${encodeProxyQuery(abs, referer, cookie, headers)}`
    })
    .join('\n')
}

async function handleProxy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
  const target = url.searchParams.get('u')
  const referer = url.searchParams.get('r') || ''
  const cookie = url.searchParams.get('c') || ''
  let variantHeaders: Record<string, string> = {}
  try {
    const h = url.searchParams.get('h')
    if (h) variantHeaders = JSON.parse(Buffer.from(h, 'base64').toString('utf8'))
  } catch {
    /* ignore */
  }
  if (!target) {
    cors(res)
    res.writeHead(400).end('missing u')
    return
  }

  let t: URL
  try {
    t = new URL(target)
  } catch {
    cors(res)
    res.writeHead(400).end('bad url')
    return
  }
  if (!hostAllowed(t.hostname)) {
    L.warn('中继拒绝：域名不在白名单', { host: t.hostname, url: t.toString().slice(0, 120) })
    cors(res)
    // 显式 statusText 让 fetch 拿到非默认 reason，避免和 upstream 403 混淆
    res.writeHead(403, 'Host not allowed')
    res.end(`host not allowed: ${t.hostname}`)
    return
  }

  // 优先使用 variant 自带请求头（UA / Referer / Origin），缺失再补默认值
  const headers: Record<string, string> = {
    'User-Agent': variantHeaders['User-Agent'] || variantHeaders['user-agent'] || pickUA(t.hostname),
    Accept: variantHeaders['Accept'] || '*/*',
    'Accept-Language': variantHeaders['Accept-Language'] || 'zh-CN,zh;q=0.9'
  }
  const ref = variantHeaders['Referer'] || variantHeaders['referer'] || referer
  if (ref) headers.Referer = ref
  let origin = variantHeaders['Origin'] || variantHeaders['origin']
  // 抖音拉流 CDN 对 pull-hls 等资源域名常要求 Origin 与 Referer 同源，
  // 缺失时按 Referer 自动补一个，否则会 403。
  if (!origin && /douyin(living|cdn|pic)?\.com$/.test(t.hostname) && ref) {
    try {
      origin = new URL(ref).origin
    } catch {
      origin = 'https://live.douyin.com'
    }
  }
  if (origin) headers.Origin = origin
  const ck = variantHeaders['Cookie'] || variantHeaders['cookie'] || cookie
  if (ck) headers.Cookie = ck
  if (req.headers.range) headers.Range = String(req.headers.range)
  L.debug('relay fetch', t.hostname, Object.keys(headers).join(','))

  try {
    const upstream = await fetch(t.toString(), { headers, redirect: 'follow' })
    if (!upstream.ok && upstream.status !== 206) {
      // 把上游 statusText 一并写进 body，方便 playerError 显示真实原因
      // （upstream 403 通常意味着：流地址签名失效 / 上游 IP 风控 / 需要特定 Referer / Cookie）
      const reason = upstream.statusText || ''
      L.warn('上游返回错误', { status: upstream.status, reason, host: t.hostname, url: t.toString().slice(0, 160) })
      cors(res)
      res.writeHead(upstream.status).end(`upstream ${upstream.status}${reason ? ' ' + reason : ''}`)
      return
    }

    const ct = upstream.headers.get('content-type') || ''
    const isPlaylist =
      /mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(t.pathname + t.search) || t.pathname.endsWith('.m3u8')

    if (isPlaylist) {
      const text = await upstream.text()
      const out = rewritePlaylist(text, t.toString(), referer, ck, {
        'User-Agent': headers['User-Agent'],
        Referer: headers.Referer,
        Origin: headers.Origin,
        Cookie: headers.Cookie
      })
      cors(res)
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
      res.setHeader('Cache-Control', 'no-cache')
      res.writeHead(200).end(out)
      return
    }

    cors(res)
    res.setHeader('Content-Type', ct || 'application/octet-stream')
    const len = upstream.headers.get('content-length')
    if (len) res.setHeader('Content-Length', len)
    const cr = upstream.headers.get('content-range')
    if (cr) res.setHeader('Content-Range', cr)
    res.setHeader('Accept-Ranges', 'bytes')
    res.writeHead(upstream.status === 206 ? 206 : 200)

    if (!upstream.body) {
      res.end()
      return
    }
    const nodeStream = Readable.fromWeb(upstream.body as any)
    nodeStream.on('error', () => res.destroy())
    res.on('close', () => nodeStream.destroy())
    nodeStream.pipe(res)
  } catch (e: any) {
    L.warn('中继失败', t.toString().slice(0, 120), e?.message ?? e)
    if (!res.headersSent) {
      cors(res)
      res.writeHead(502)
    }
    res.end(String(e?.message ?? e))
  }
}

/** ffmpeg 实时转码预览端点：HEVC/H.265 → H.264 FLV。
 *  浏览器（尤其 Electron 带的 Chromium）常不支持 HEVC MSE，录制走 ffmpeg -c copy 没问题，
 *  预览就通过这个端点实时转码。 */
async function handleTranscode(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
  const target = url.searchParams.get('u')
  const referer = url.searchParams.get('r') || ''
  const cookie = url.searchParams.get('c') || ''
  let variantHeaders: Record<string, string> = {}
  try {
    const h = url.searchParams.get('h')
    if (h) variantHeaders = JSON.parse(Buffer.from(h, 'base64').toString('utf8'))
  } catch {
    /* ignore */
  }

  if (!target) {
    cors(res)
    res.writeHead(400).end('missing u')
    return
  }

  let t: URL
  try {
    t = new URL(target)
  } catch {
    cors(res)
    res.writeHead(400).end('bad url')
    return
  }
  if (!hostAllowed(t.hostname)) {
    cors(res)
    res.writeHead(403, 'Host not allowed').end(`host not allowed: ${t.hostname}`)
    return
  }

  let exe: string
  try {
    exe = requireFfmpeg()
  } catch (e: any) {
    L.warn('转码预览未找到 ffmpeg', e?.message ?? e)
    cors(res)
    res.writeHead(503).end(`ffmpeg not found: ${e?.message ?? e}`)
    return
  }

  const variant: StreamVariant = {
    quality: 'transcode',
    label: '转码预览',
    url: target,
    format: 'hls',
    headers: {
      ...variantHeaders,
      ...(referer ? { Referer: referer } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    }
  }

  const args = buildPreviewTranscodeArgs({ url: target, variant, userAgent: variantHeaders['User-Agent'] })
  L.info('转码预览启动', `${args.join(' ').slice(0, 240)}…`)
  const proc = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

  proc.stderr?.on('data', (buf: Buffer) => {
    const text = buf.toString('utf8').trim()
    if (text) L.warn('transcode stderr', text.slice(0, 500))
  })

  const cleanup = (reason: string) => {
    L.debug('转码预览结束', reason)
    try {
      proc.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }

  req.on('close', () => cleanup('client closed'))
  req.on('aborted', () => cleanup('client aborted'))
  res.on('close', () => cleanup('response closed'))

  proc.on('error', (err) => {
    L.warn('转码预览进程错误', err)
    if (!res.headersSent) {
      cors(res)
      res.writeHead(502).end(String(err.message ?? err))
    } else {
      res.destroy()
    }
  })

  proc.on('exit', (code) => {
    if (code && code !== 0) L.warn('转码预览进程提前退出', { code })
    if (!res.destroyed) res.end()
  })

  // 等 ffmpeg 吐出头几个字节再发响应头，避免客户端看到空 FLV 就报错。
  // 注意：首块（含 FLV 头 13 字节）必须转发给客户端 —— 之前用 stdout.once('data')
  // 吞掉首块做校验、再 pipe(res) 的写法会丢 FLV 头，导致 mpegts.js 收到缺头流立即
  // MediaError。这里改为每个 chunk 都 write，含首块。
  const stdout = proc.stdout!
  let headSent = false
  const trySendHead = (chunk: Buffer): boolean => {
    const first = chunk.slice(0, 9)
    const hex = Array.from(first)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
    const isFlv = first[0] === 0x46 && first[1] === 0x4c && first[2] === 0x56
    L.info('转码首个字节', { len: chunk.length, headHex: hex, isFlv })
    if (!isFlv) {
      // ffmpeg 起手就不是 FLV（多半是上游 403 / HEVC 解码失败 / 参数错误），
      // 不再转发，直接结束连接，让播放器拿到明确的错误而非一段垃圾流。
      L.warn('转码未产出 FLV 头（ffmpeg 起手失败）', { headHex: hex })
      return false
    }
    cors(res)
    res.setHeader('Content-Type', 'video/x-flv')
    res.setHeader('Cache-Control', 'no-cache')
    res.writeHead(200)
    headSent = true
    return true
  }
  stdout.on('data', (chunk: Buffer) => {
    if (!headSent && !trySendHead(chunk)) {
      cleanup('not flv')
      return
    }
    res.write(chunk)
  })
}

/** 启动中继；重复调用返回同一个端口 */
export async function startRelay(preferredPort = 0): Promise<number> {
  if (server && port) return port

  server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      cors(res)
      res.writeHead(204).end()
      return
    }
    // 注意：/dm-page 必须排在 /dm 前面，否则会被 /dm 前缀抢先匹配
    if ((req.url || '').startsWith('/dm-page')) {
      cors(res)
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      res.writeHead(200).end(dmPageHtml || '<html><body>dm page not installed</body></html>')
      return
    }
    if ((req.url || '').startsWith('/dm')) {
      void handleDm(req, res)
      return
    }
    if ((req.url || '').startsWith('/proxy')) {
      void handleProxy(req, res)
      return
    }
    if ((req.url || '').startsWith('/transcode')) {
      void handleTranscode(req, res)
      return
    }
    cors(res)
    res.writeHead(404).end('relay')
  })

  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(preferredPort, '127.0.0.1', () => resolve())
  })

  port = (server.address() as AddressInfo).port
  L.info('流中继已启动', `127.0.0.1:${port}`)
  return port
}

export function relayPort(): number {
  return port
}

export function stopRelay(): void {
  for (const s of sockets) {
    try {
      s.destroy()
    } catch {
      /* ignore */
    }
  }
  sockets.clear()
  if (server) {
    server.close()
    server = null
  }
  port = 0
}

/** 把上游流地址包装成中继地址 */
export function proxied(
  url: string,
  referer: string,
  headers?: Record<string, string>,
  cookie?: string
): string {
  const params = new URLSearchParams()
  params.set('u', url)
  if (referer) params.set('r', referer)
  if (cookie) params.set('c', cookie)
  if (headers && Object.keys(headers).length) {
    params.set('h', Buffer.from(JSON.stringify(headers)).toString('base64'))
  }
  return `http://127.0.0.1:${port}/proxy?${params.toString()}`
}

/** 把上游流地址包装成「ffmpeg 实时转码 H.264」的中继地址（用于浏览器无法硬解 HEVC 时预览） */
export function transcoded(
  url: string,
  referer: string,
  headers?: Record<string, string>,
  cookie?: string
): string {
  return `http://127.0.0.1:${port}/transcode?${encodeProxyQuery(url, referer, cookie, headers)}`
}