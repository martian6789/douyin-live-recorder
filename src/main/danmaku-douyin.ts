/**
 * 抖音弹幕（隐藏 Chromium 窗口方案）。
 *
 * 为什么不能像 B 站那样在主进程里直接连 WebSocket：
 * 抖音弹幕服务（webcast im push）对 TLS/JA3 指纹做风控，Node 的 OpenSSL
 * 指纹一律吃 DEVICE_BLOCKED（握手 415），换什么 Cookie 都没用 —— 实测过。
 * 只有真实 Chromium 网络栈能过。所以这里开一个隐藏的 BrowserWindow，
 * 在窗口页面里连 wss 弹幕、解 protobuf，再把弹幕 POST 回本地中继 /dm。
 *
 * 资源纪律：所有房间共用一个隐藏窗口；没有房间在用时空闲 60s 自动销毁。
 */
import { BrowserWindow, session } from 'electron'
import { log } from './logger'
import { startRelay, relayPort, setDmPage } from './relay'

const L = log('douyin-danmaku')

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let win: BrowserWindow | null = null
let starting: Promise<void> | null = null
const active = new Set<string>()
let idleTimer: NodeJS.Timeout | null = null
let headersHooked = false
let pageInstalled = false

/** 给弹幕 WS 握手补 Origin / Referer / UA：裸握手（无 Origin）会被风控直接拒 */
function hookHeaders(): void {
  if (headersHooked) return
  headersHooked = true
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, cb) => {
    const u = details.url
    if ((u.startsWith('wss://') || u.startsWith('https://')) && u.includes('/webcast/im/push/')) {
      cb({
        requestHeaders: {
          ...details.requestHeaders,
          Origin: 'https://live.douyin.com',
          Referer: 'https://live.douyin.com/',
          'User-Agent': CHROME_UA
        }
      })
      return
    }
    cb({})
  })
}

/**
 * 匿名连弹幕的前提是会话里有 ttwid Cookie（登录过的会话本来就有）。
 * 没有就先用 Chromium 网络栈访问一次直播首页，从 Set-Cookie 里拿一个。
 */
async function seedTtwid(): Promise<void> {
  try {
    const cookies = await session.defaultSession.cookies.get({ name: 'ttwid' })
    if (cookies.some((c) => (c.domain ?? '').includes('douyin') && c.value)) return
    await session.defaultSession.fetch('https://live.douyin.com/', {
      headers: { 'User-Agent': CHROME_UA }
    })
  } catch (e: any) {
    L.warn('ttwid 预取失败（仍会尝试连弹幕）', e?.message ?? e)
  }
}

async function ensureWindow(): Promise<void> {
  if (win && !win.isDestroyed()) return
  if (starting) return starting
  starting = (async () => {
    hookHeaders()
    installPage()
    const port = await startRelay(0)
    await seedTtwid()
    win = new BrowserWindow({
      show: false,
      width: 360,
      height: 240,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: false,
        // 隐藏窗口默认会被节流（定时器停摆 → 心跳断 → 弹幕掉线），必须关掉
        backgroundThrottling: false
      }
    })
    win.on('closed', () => {
      win = null
      starting = null
      active.clear()
    })
    await win.loadURL(`http://127.0.0.1:${port}/dm-page`)
    L.info('抖音弹幕窗口已就绪（隐藏）')
  })()
  try {
    await starting
  } finally {
    starting = null
  }
}

/** 某房间开始收弹幕（幂等） */
export async function douyinDmStart(roomId: string): Promise<void> {
  const room = String(roomId)
  if (active.has(room)) return
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  await ensureWindow()
  if (!win || win.isDestroyed()) throw new Error('弹幕窗口创建失败')
  active.add(room)
  await win.webContents.executeJavaScript(
    `window.__dmStart && window.__dmStart(${JSON.stringify(room)})`
  )
  L.info('弹幕连接启动', room)
}

/** 某房间停止收弹幕；全部停掉后空闲 60s 销毁窗口 */
export function douyinDmStop(roomId: string): void {
  const room = String(roomId)
  if (!active.has(room)) return
  active.delete(room)
  if (win && !win.isDestroyed()) {
    void win.webContents
      .executeJavaScript(`window.__dmStop && window.__dmStop(${JSON.stringify(room)})`)
      .catch(() => void 0)
  }
  L.info('弹幕连接停止', room)
  if (active.size === 0 && !idleTimer) {
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (active.size === 0 && win && !win.isDestroyed()) {
        L.info('弹幕空闲，销毁隐藏窗口')
        win.destroy()
      }
    }, 60_000)
  }
}

function installPage(): void {
  if (pageInstalled) return
  pageInstalled = true
  setDmPage(buildDmPageHtml())
}

/**
 * 弹幕窗口页面：连接 wss 弹幕、解 PushFrame/gzip/Response/Message、回传 /dm。
 * 注意：这段代码作为字符串注入，里面不能出现反引号和 ${ （会和外层模板串冲突）。
 *
 * protobuf 字段号（抖音 webcast，与 douyin-live-go 一致）：
 *   PushFrame: logId=2, headersList=5, payloadEncoding=6, payloadType=7, payload=8
 *   Response:  messagesList=1, internalExt=5, needAck=9
 *   Message:   method=1, payload=2, msgId=3
 *   ChatMessage:   user=2, content=3        User: id=1, nickName=3
 *   GiftMessage:   giftId=2, fanTicket=3, repeatCount=5, user=7
 *   MemberMessage: user=2, memberCount=3    LikeMessage: count=2, total=3, user=5
 */
function buildDmPageHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<script>
'use strict'
var te = new TextEncoder()
var tde = new TextDecoder()
var HOSTS = ['webcast5-ws-web-hl.douyin.com', 'webcast5-ws-web-lf.douyin.com']
var MAX_RETRY = 15
var conns = new Map()

function post(room, obj) {
  fetch('/dm?room=' + encodeURIComponent(room), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  }).catch(function () {})
}

/* ---------------- 极简 protobuf 解码 ---------------- */
function pbReader(buf) {
  var pos = 0
  function varint() {
    var r = 0n, s = 0n
    for (;;) {
      var b = buf[pos++]
      r |= BigInt(b & 0x7f) << s
      if (!(b & 0x80)) break
      s += 7n
    }
    return r
  }
  function bytes() {
    var len = Number(varint())
    var out = buf.subarray(pos, pos + len)
    pos += len
    return out
  }
  function skip(w) {
    if (w === 0) varint()
    else if (w === 1) pos += 8
    else if (w === 2) bytes()
    else if (w === 5) pos += 4
    else throw new Error('wire ' + w)
  }
  return {
    varint: varint,
    bytes: bytes,
    skip: skip,
    get end() { return pos >= buf.length }
  }
}
function str(b) { return tde.decode(b) }

function parsePushFrame(buf) {
  var r = pbReader(buf), f = { logId: 0n, payloadType: '', payload: null }
  while (!r.end) {
    var key = Number(r.varint()), field = key >> 3, wire = key & 7
    if (field === 2 && wire === 0) f.logId = r.varint()
    else if (field === 7 && wire === 2) f.payloadType = str(r.bytes())
    else if (field === 8 && wire === 2) f.payload = r.bytes()
    else r.skip(wire)
  }
  return f
}
function parseResponse(buf) {
  var r = pbReader(buf), out = { msgs: [], internalExt: '', needAck: false }
  while (!r.end) {
    var key = Number(r.varint()), field = key >> 3, wire = key & 7
    if (field === 1 && wire === 2) out.msgs.push(parseMessage(r.bytes()))
    else if (field === 5 && wire === 2) out.internalExt = str(r.bytes())
    else if (field === 9 && wire === 0) out.needAck = r.varint() !== 0n
    else r.skip(wire)
  }
  return out
}
function parseMessage(buf) {
  var r = pbReader(buf), m = { method: '', payload: null, msgId: '' }
  while (!r.end) {
    var key = Number(r.varint()), field = key >> 3, wire = key & 7
    if (field === 1 && wire === 2) m.method = str(r.bytes())
    else if (field === 2 && wire === 2) m.payload = r.bytes()
    else if (field === 3 && wire === 0) m.msgId = r.varint().toString()
    else r.skip(wire)
  }
  return m
}
function parseUser(buf) {
  var r = pbReader(buf), u = { id: '', nick: '' }
  while (!r.end) {
    var key = Number(r.varint()), field = key >> 3, wire = key & 7
    if (field === 1 && wire === 0) u.id = r.varint().toString()
    else if (field === 3 && wire === 2) u.nick = str(r.bytes())
    else r.skip(wire)
  }
  return u
}
function parseChat(buf) {
  var r = pbReader(buf), c = { user: '', uid: '', text: '' }
  while (!r.end) {
    var key = Number(r.varint()), field = key >> 3, wire = key & 7
    if (field === 2 && wire === 2) { var u = parseUser(r.bytes()); c.user = u.nick; c.uid = u.id }
    else if (field === 3 && wire === 2) c.text = str(r.bytes())
    else r.skip(wire)
  }
  return c
}
function parseGift(buf) {
  var r = pbReader(buf), g = { user: '', uid: '', giftId: '', count: 1 }
  while (!r.end) {
    var key = Number(r.varint()), field = key >> 3, wire = key & 7
    if (field === 2 && wire === 0) g.giftId = r.varint().toString()
    else if (field === 5 && wire === 0) g.count = Number(r.varint()) || 1
    else if (field === 7 && wire === 2) { var u = parseUser(r.bytes()); g.user = u.nick; g.uid = u.id }
    else r.skip(wire)
  }
  return g
}
function parseMember(buf) {
  var r = pbReader(buf), m = { user: '', uid: '' }
  while (!r.end) {
    var key = Number(r.varint()), field = key >> 3, wire = key & 7
    if (field === 2 && wire === 2) { var u = parseUser(r.bytes()); m.user = u.nick; m.uid = u.id }
    else r.skip(wire)
  }
  return m
}
function parseLike(buf) {
  var r = pbReader(buf), k = { user: '', uid: '', count: 1 }
  while (!r.end) {
    var key = Number(r.varint()), field = key >> 3, wire = key & 7
    if (field === 2 && wire === 0) k.count = Number(r.varint()) || 1
    else if (field === 5 && wire === 2) { var u = parseUser(r.bytes()); k.user = u.nick; k.uid = u.id }
    else r.skip(wire)
  }
  return k
}

/* ---------------- PushFrame 编码（ack / 心跳） ---------------- */
function encVarint(v) {
  v = BigInt(v)
  var out = []
  do {
    var b = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) b |= 0x80
    out.push(b)
  } while (v > 0n)
  return out
}
function fieldBytes(f, b) { return encVarint((f << 3) | 2).concat(encVarint(b.length), Array.from(b)) }
function encodePushFrame(opts) {
  var parts = []
  if (opts.logId) parts = parts.concat(encVarint(2 << 3), encVarint(opts.logId))
  if (opts.payloadType) parts = parts.concat(fieldBytes(7, te.encode(opts.payloadType)))
  if (opts.payload && opts.payload.length) parts = parts.concat(fieldBytes(8, opts.payload))
  return new Uint8Array(parts)
}

async function gunzip(buf) {
  var ds = new DecompressionStream('gzip')
  var stream = new Blob([buf]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function wsUrl(roomId, host) {
  var p = new URLSearchParams()
  p.set('app_name', 'douyin_web')
  p.set('version_code', '180800')
  p.set('webcast_sdk_version', '1.3.0')
  p.set('update_version_code', '1.3.0')
  p.set('compress', 'gzip')
  p.set('device_platform', 'web')
  p.set('cookie_enabled', 'true')
  p.set('screen_width', '1920')
  p.set('screen_height', '1080')
  p.set('browser_language', 'zh-CN')
  p.set('browser_platform', 'Win32')
  p.set('browser_name', 'Mozilla')
  p.set('browser_version', '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
  p.set('browser_online', 'true')
  p.set('tz_name', 'Asia/Shanghai')
  p.set('identity', 'audience')
  p.set('room_id', roomId)
  p.set('heartbeatDuration', '0')
  p.set('aid', '6383')
  p.set('live_id', '1')
  p.set('did_rule', '3')
  p.set('endpoint', 'live_pc')
  p.set('user_unique_id', String(Date.now()))
  return 'wss://' + host + '/webcast/im/push/v2/?' + p.toString()
}

function dispatch(roomId, m) {
  if (!m.payload || !m.payload.length) return
  var method = m.method || ''
  try {
    if (method === 'WebcastChatMessage') {
      var c = parseChat(m.payload)
      if (c.text) post(roomId, { type: 'chat', user: c.user, uid: c.uid, text: c.text })
    } else if (method === 'WebcastGiftMessage') {
      var g = parseGift(m.payload)
      post(roomId, {
        type: 'gift', user: g.user, uid: g.uid,
        text: '送出礼物 #' + g.giftId + (g.count > 1 ? ' ×' + g.count : ''),
        giftName: '#' + g.giftId, giftCount: g.count
      })
    } else if (method === 'WebcastMemberMessage') {
      var mb = parseMember(m.payload)
      if (mb.user) post(roomId, { type: 'enter', user: mb.user, uid: mb.uid, text: '进入直播间' })
    } else if (method === 'WebcastLikeMessage') {
      var k = parseLike(m.payload)
      post(roomId, { type: 'like', user: k.user, uid: k.uid, text: '为主播点赞' + (k.count > 1 ? ' ×' + k.count : '') })
    } else if (method === 'WebcastSocialMessage') {
      var s = parseMember(m.payload)
      if (s.user) post(roomId, { type: 'system', user: s.user, uid: s.uid, text: '关注了主播' })
    }
  } catch (e) { /* 单条坏消息不影响整体 */ }
}

async function onFrame(roomId, ws, data) {
  try {
    var frame = parsePushFrame(new Uint8Array(data))
    if (!frame.payload || !frame.payload.length) return
    var payload = frame.payload
    if (payload[0] === 0x1f && payload[1] === 0x8b) {
      try { payload = await gunzip(payload) } catch (e) { return }
    }
    var resp = parseResponse(payload)
    if (resp.needAck && resp.internalExt) {
      try { ws.send(encodePushFrame({ logId: frame.logId, payloadType: 'ack', payload: te.encode(resp.internalExt) })) } catch (e) {}
    }
    for (var i = 0; i < resp.msgs.length; i++) dispatch(roomId, resp.msgs[i])
  } catch (e) { /* 单帧失败忽略 */ }
}

function connect(roomId, c) {
  if (c.stopped) return
  post(roomId, { __status: 'connecting' })
  var host = HOSTS[c.hostIdx % HOSTS.length]
  var ws
  try {
    ws = new WebSocket(wsUrl(roomId, host))
  } catch (e) {
    scheduleRetry(roomId, c)
    return
  }
  c.ws = ws
  ws.binaryType = 'arraybuffer'
  ws.onopen = function () {
    c.retries = 0
    post(roomId, { __status: 'open' })
    c.hb = setInterval(function () {
      try { ws.send(encodePushFrame({ payloadType: 'hb' })) } catch (e) {}
    }, 10000)
  }
  ws.onmessage = function (ev) { void onFrame(roomId, ws, ev.data) }
  ws.onerror = function () { /* onclose 统一处理 */ }
  ws.onclose = function () {
    if (c.hb) { clearInterval(c.hb); c.hb = null }
    if (c.stopped) return
    c.hostIdx++
    scheduleRetry(roomId, c)
  }
}

function scheduleRetry(roomId, c) {
  if (c.stopped) return
  c.retries++
  if (c.retries > MAX_RETRY) {
    post(roomId, { __status: 'error', msg: '抖音弹幕连接失败（可能被风控拦截或主播未在播），稍后将自动重试' })
    return
  }
  c.timer = setTimeout(function () { connect(roomId, c) }, Math.min(30000, 2000 * c.retries))
}

window.__dmStart = function (roomId) {
  roomId = String(roomId)
  var c = conns.get(roomId)
  if (c && !c.stopped) return
  c = { ws: null, hb: null, timer: null, retries: 0, hostIdx: 0, stopped: false }
  conns.set(roomId, c)
  connect(roomId, c)
}
window.__dmStop = function (roomId) {
  roomId = String(roomId)
  var c = conns.get(roomId)
  if (!c) return
  c.stopped = true
  if (c.hb) clearInterval(c.hb)
  if (c.timer) clearTimeout(c.timer)
  try { if (c.ws) c.ws.close() } catch (e) {}
  conns.delete(roomId)
}
</script>
</body></html>`
}
