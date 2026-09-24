/**
 * 抖音「搜主播 / 定位主播」—— 输入任意线索，定位主播主页并拿到资料。
 *
 * 支持输入：
 *   1. 主播昵称（如「疯狂小杨哥」）—— 需登录态（搜索接口是登录态接口）。
 *   2. 抖音号 / 主播ID（纯数字或字母手柄，如 32093862395 / qjandu17177）
 *      —— 有登录态走签名搜索；无登录态走「直播页 SSR 兜底」（免登录）。
 *   3. 作品链接 / 作品ID（v.douyin.com/…、douyin.com/video/…、纯 15~19 位数字）
 *      —— 免登录：用作品详情接口反查作者主页。
 *   4. 主播主页链接（douyin.com/user/<sec_uid>）或裸 sec_uid。
 *   5. 直播链接（live.douyin.com/…、follow/live/…、douyin.com/room/…）。
 *
 * 核心手段（参考 Doubao 方案，2026-09 实测）：
 *   抖音网页在游客态自带签名器 `window.byted_acrawler.frontierSign({url})`，
 *   能在页面上下文里生成 `X-Bogus` 签名。于是：
 *     - 在隐藏窗口加载抖音页拿到签名器；
 *     - 在页面上下文里 `fetch` 调接口（同域，自动带登录 Cookie）；
 *     - 直接解析返回的 JSON，比「刮渲染后的 DOM」稳得多。
 *
 * 两条接口：
 *   - aweme/detail（作品详情）：游客态即可用，免登录 → 反查作者主页。
 *   - discover/search（搜索）：登录态接口，带 X-Bogus + 登录 Cookie 才有结果。
 *
 * 抖音号 → 主页的边界（官方限制，实测确认）：
 *   纯抖音号在游客态没有免登录「号→主页」通道，所以「无登录 + 纯数字抖音号」
 *   走直播页 SSR 兜底拿名字/主页；若是主播昵称（非手柄）则必须登录。
 */
import { BrowserWindow } from 'electron'
import { request } from './providers/http'
import { getCookie, dataDir } from './store'
import { enterFromPage } from './providers/douyin'
import { log } from './logger'
import fs from 'node:fs'
import path from 'node:path'
import type { DouyinSearchUser } from '../shared/types'

const L = log('douyin-search')

/* ============================ 工具 ============================ */

function pickUrl(list: unknown, ix = 0): string | undefined {
  if (Array.isArray(list)) {
    const v = list.find((x) => typeof x === 'string' && x.startsWith('http'))
    if (v) return v as string
    if (typeof list[ix] === 'string') return list[ix] as string
  }
  return undefined
}

function firstNum(node: any, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = node?.[k]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return String(v)
    if (typeof v === 'string' && /^\d{4,}$/.test(v)) return v
  }
  return undefined
}

/** 由 unique_id / sec_uid 构造两条固定链接 */
function linksFrom(opts: { douyinId?: string; secUid?: string }): { homeUrl?: string; liveUrl?: string } {
  const homeUrl = opts.secUid ? `https://www.douyin.com/user/${opts.secUid}` : undefined
  const liveUrl = opts.douyinId ? `https://live.douyin.com/${opts.douyinId}` : undefined
  return { homeUrl, liveUrl }
}

/* ============================ 免签名接口 ============================ */

/** profile/other：用户详情（含昵称 / 抖音号 / 粉丝 / 直播间号），免 a_bogus 但需登录 Cookie */
async function fetchProfile(secUid: string, cookie: string): Promise<DouyinSearchUser | null> {
  const qs = new URLSearchParams({
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    sec_user_id: secUid,
    cookie_enabled: 'true',
    platform: 'PC'
  })
  try {
    const res = await request(`https://www.douyin.com/aweme/v1/web/user/profile/other/?${qs.toString()}`, {
      cookie,
      referer: 'https://www.douyin.com/',
      timeoutMs: 15000
    })
    const j = res.json<any>()
    const u = j?.user
    if (!u || typeof u.sec_uid !== 'string') return null
    const avatar = pickUrl(u.avatar_thumb?.url_list) ?? pickUrl(u.avatar_larger?.url_list)
    const rid = firstNum(u, ['room_id', 'web_rid', 'live_room_id'])
    const living = u.live_status === 1 || !!rid
    const { homeUrl, liveUrl } = linksFrom({ douyinId: u.unique_id, secUid: u.sec_uid })
    return {
      secUid: u.sec_uid,
      nickname: typeof u.nickname === 'string' ? u.nickname : '',
      douyinId: (typeof u.unique_id === 'string' && u.unique_id) || (typeof u.short_id === 'string' && u.short_id) || '',
      signature: typeof u.signature === 'string' ? u.signature.slice(0, 120) : '',
      followers: typeof u.follower_count === 'number' ? u.follower_count : undefined,
      avatar,
      living: living || undefined,
      roomId: rid,
      homeUrl,
      liveUrl,
      roomUrl: rid ? `https://live.douyin.com/${rid}` : undefined
    }
  } catch (e: any) {
    L.warn('[profile] 补全失败', { secUid: secUid.slice(0, 20), msg: e?.message ?? e })
    return null
  }
}

/** profile 接口裸返回（给反查逻辑用） */
export async function rawProfile(secUid: string, cookie: string): Promise<any> {
  const qs = new URLSearchParams({
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    sec_user_id: secUid,
    cookie_enabled: 'true',
    platform: 'PC'
  })
  const res = await request(`https://www.douyin.com/aweme/v1/web/user/profile/other/?${qs.toString()}`, {
    cookie,
    referer: 'https://www.douyin.com/',
    timeoutMs: 15000
  })
  return res.json<any>()
}

/**
 * 用 sec_uid 反查当前直播间号 —— 「未开播先加监控」链路的核心。
 * 未开播返回空 roomId 是正常结果，不是失败。
 */
export async function resolveRoomIdBySecUid(
  secUid: string
): Promise<{ roomId?: string; needCookie?: boolean; error?: string }> {
  const cookie = getCookie('douyin')
  if (!cookie) {
    return {
      needCookie: true,
      error: '需要抖音登录态：未登录时抖音不返回直播间号（请先登录抖音并导入 Cookie）'
    }
  }
  try {
    const rid = firstNum((await rawProfile(secUid, cookie))?.user ?? {}, ['room_id', 'web_rid', 'live_room_id'])
    if (rid) return { roomId: rid }
    return {}
  } catch (e: any) {
    return { error: e?.message ?? String(e) }
  }
}

/* ============================ 页面内签名 + 调接口 ============================ */

/** 在页面上下文里：等签名器就绪 → 用 frontierSign 签 X-Bogus → fetch 接口 → 返回文本 */
const SIGN_FETCH_FN = `
async (apiPath) => {
  const t0 = Date.now();
  const ok = () => window.byted_acrawler && typeof window.byted_acrawler.frontierSign === 'function';
  while (!ok() && Date.now() - t0 < 20000) { await new Promise(r => setTimeout(r, 200)); }
  if (!ok()) throw new Error('signer_unavailable');
  const ts = Date.now();
  const sep = apiPath.includes('?') ? '&' : '?';
  const path = apiPath + sep + 'ts=' + ts;
  const sig = window.byted_acrawler.frontierSign({ url: path });
  const xb = sig && (sig['X-Bogus'] || sig['X-Bogus'] || sig['a_bogus']);
  if (!xb) throw new Error('sign_failed');
  // 抖音两套签名参数名：X-Bogus / a_bogus；按签名器实际返回的字段名选用
  const pname = (sig && sig['a_bogus']) ? 'a_bogus' : 'X-Bogus';
  const url = 'https://www.douyin.com' + path + '&' + pname + '=' + xb;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' }, credentials: 'include' });
  return await r.text();
}
`

/** 开一个隐藏窗口并加载抖音页（拿到游客签名环境）；可选注入登录 Cookie */
async function openSignWindow(cookie?: string): Promise<{
  win: BrowserWindow
  cleanup: () => void
  injected: number
}> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 860,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false
    }
  })
  const ses = win.webContents.session
  let injected = 0
  if (cookie) {
    for (const part of cookie.split(';')) {
      const p = part.trim()
      const i = p.indexOf('=')
      if (i <= 0) continue
      const name = p.slice(0, i).trim()
      const value = p.slice(i + 1).trim()
      if (!name || !value) continue
      try {
        await ses.cookies.set({ url: 'https://www.douyin.com', name, value, domain: '.douyin.com', path: '/' })
        injected++
      } catch {
        /* 单条失败不影响整体 */
      }
    }
  }
  try {
    const ua = win.webContents.getUserAgent().replace(/\s*(Electron|live-review|LiveReview)\/[\d.]+/gi, '')
    win.webContents.setUserAgent(ua)
  } catch {
    /* ignore */
  }
  const cleanup = (): void => {
    try {
      if (!win.isDestroyed()) win.destroy()
    } catch {
      /* ignore */
    }
  }
  return { win, cleanup, injected }
}

/** 页面内签名后请求，返回解析后的 JSON */
async function signJson(win: BrowserWindow, apiPath: string): Promise<any> {
  const text = (await win.webContents.executeJavaScript(
    '(' + SIGN_FETCH_FN + ')(' + JSON.stringify(apiPath) + ')'
  )) as string
  return JSON.parse(text)
}

/* ============================ 各输入类型的解析 ============================ */

type Cls = 'videoUrl' | 'videoId' | 'userUrl' | 'secUid' | 'liveUrl' | 'nameOrId'

function classify(raw: string): { type: Cls; value: string } {
  const s = (raw || '').trim()
  let m: RegExpExecArray | null
  if ((m = /douyin\.com\/user\/([A-Za-z0-9_\-]{10,})/i.exec(s))) return { type: 'userUrl', value: m[1] }
  if (/^MS4wLjAB[A-Za-z0-9_\-]{10,}$/.test(s)) return { type: 'secUid', value: s }
  if ((m = /live\.douyin\.com\/([A-Za-z0-9_\-]+)/i.exec(s))) return { type: 'liveUrl', value: m[1] }
  if ((m = /douyin\.com\/follow\/live\/(\d+)/i.exec(s))) return { type: 'liveUrl', value: m[1] }
  if ((m = /douyin\.com\/room\/(\d+)/i.exec(s))) return { type: 'liveUrl', value: m[1] }
  if (/v\.douyin\.com\//i.test(s) || /douyin\.com\/video\/\d+/i.test(s) || /iesdouyin\.com\/share\/video\/\d+/i.test(s))
    return { type: 'videoUrl', value: s }
  if (/^\d{15,19}$/.test(s)) return { type: 'videoId', value: s }
  return { type: 'nameOrId', value: s }
}

/** 从 aweme/detail 的作者块构造候选（免登录） */
function userFromAuthor(a: any): DouyinSearchUser | null {
  if (!a || !a.sec_uid) return null
  const avatar = pickUrl(a.avatar_thumb?.url_list) ?? pickUrl(a.avatar_larger?.url_list)
  const { homeUrl, liveUrl } = linksFrom({ douyinId: a.unique_id, secUid: a.sec_uid })
  return {
    secUid: a.sec_uid,
    nickname: typeof a.nickname === 'string' ? a.nickname : '',
    douyinId: (typeof a.unique_id === 'string' && a.unique_id) || (typeof a.short_id === 'string' && a.short_id) || '',
    signature: typeof a.signature === 'string' ? a.signature.slice(0, 120) : '',
    followers: typeof a.follower_count === 'number' ? a.follower_count : undefined,
    avatar,
    homeUrl,
    liveUrl
  }
}

/** 从 discover/search 的 user_info 构造候选（需登录） */
function userFromSearchInfo(ui: any): DouyinSearchUser | null {
  if (!ui || !ui.sec_uid) return null
  const avatar = pickUrl(ui.avatar_thumb?.url_list) ?? pickUrl(ui.avatar_larger?.url_list)
  const rid = firstNum(ui, ['room_id', 'web_rid', 'live_room_id'])
  const living = ui.live_status === 1 || !!rid
  const { homeUrl, liveUrl } = linksFrom({ douyinId: ui.unique_id, secUid: ui.sec_uid })
  return {
    secUid: ui.sec_uid,
    nickname: typeof ui.nickname === 'string' ? ui.nickname : '',
    douyinId: (typeof ui.unique_id === 'string' && ui.unique_id) || (typeof ui.short_id === 'string' && ui.short_id) || '',
    signature: typeof ui.signature === 'string' ? ui.signature.slice(0, 120) : '',
    followers: typeof ui.follower_count === 'number' ? ui.follower_count : undefined,
    avatar,
    living: living || undefined,
    roomId: rid,
    homeUrl,
    liveUrl,
    roomUrl: rid ? `https://live.douyin.com/${rid}` : undefined
  }
}

/** 从直播页 SSR 兜底（免登录）：拿主播名 + sec_uid + 封面 */
async function userFromLivePage(id: string): Promise<DouyinSearchUser | null> {
  try {
    const j = await enterFromPage(id)
    const owner = j?.data?.room?.owner
    if (!owner?.nickname && !owner?.sec_uid) return null
    const { homeUrl, liveUrl } = linksFrom({ douyinId: id, secUid: owner?.sec_uid })
    return {
      secUid: owner?.sec_uid ?? '',
      nickname: owner?.nickname ?? '',
      douyinId: id,
      avatar: j?.data?.room?.cover?.url_list?.[0],
      homeUrl,
      liveUrl
    }
  } catch (e: any) {
    L.warn('[livePage] SSR 兜底失败', { id, msg: e?.message ?? e })
    return null
  }
}

/** 作品详情：页面内签名 + aweme/detail（免登录） */
async function resolveVideo(videoRef: string): Promise<DouyinSearchUser | null> {
  const { win, cleanup, injected } = await openSignWindow()
  try {
    await win.loadURL('https://www.douyin.com/')
    // 若是短链/视频页，先拿到真实视频 ID
    let id = /^\d{15,19}$/.test(videoRef.trim()) ? videoRef.trim() : ''
    if (!id) {
      if (/douyin\.com\/video\/\d+/i.test(videoRef)) {
        const m = /douyin\.com\/video\/(\d{15,19})/i.exec(videoRef)
        id = m?.[1] ?? ''
      } else {
        // v.douyin.com 短链：在窗口里跟随重定向拿到真实 URL
        try {
          await win.loadURL(videoRef)
          const finalUrl = win.webContents.getURL()
          const m = /douyin\.com\/video\/(\d{15,19})/i.exec(finalUrl)
          id = m?.[1] ?? ''
        } catch {
          /* ignore */
        }
      }
    }
    if (!id) {
      L.warn('[video] 无法从输入提取作品ID', { videoRef })
      return null
    }
    const apiPath =
      `/aweme/v1/web/aweme/detail/?device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=${id}`
    const j = await signJson(win, apiPath)
    const a = j?.aweme_detail?.author
    if (!a) {
      L.warn('[video] aweme/detail 无 author', { id, status: j?.status_code, msg: j?.status_msg })
      return null
    }
    L.info('[video] 反查成功', { id, nickname: a.nickname })
    return userFromAuthor(a)
  } catch (e: any) {
    L.warn('[video] 解析失败', { videoRef, msg: e?.message ?? e })
    return null
  } finally {
    cleanup()
    void injected
  }
}

/** 搜索：页面内签名 + discover/search（需登录） */
async function resolveSearch(kw: string, cookie: string): Promise<DouyinSearchUser[]> {
  const { win, cleanup, injected } = await openSignWindow(cookie)
  try {
    await win.loadURL('https://www.douyin.com/')
    const enc = encodeURIComponent(kw)
    const apiPath =
      `/aweme/v1/web/discover/search/?device_platform=webapp&aid=6383&channel=channel_pc_web` +
      `&search_channel=aweme_general&keyword=${enc}&search_source=normal_search&query_correct_type=1`
    const j = await signJson(win, apiPath)
    const list = j?.user_list ?? []
    const users = list
      .map((x: any) => userFromSearchInfo(x?.user_info))
      .filter((u: DouyinSearchUser | null): u is DouyinSearchUser => !!u)
      .slice(0, 15)
    L.info('[search] 完成', { kw, n: users.length, injected })
    return users
  } catch (e: any) {
    L.warn('[search] 失败', { kw, msg: e?.message ?? e, injected })
    return []
  } finally {
    cleanup()
  }
}

/* ============================ 统一入口 ============================ */

export interface DouyinSearchResult {
  ok: boolean
  users: DouyinSearchUser[]
  error?: string
  /** 缺 Cookie / Cookie 过期时为 true，界面据此引导登录 */
  needCookie?: boolean
}

/** 把失败诊断落盘，便于事后排查 */
function dumpDebug(d: unknown): void {
  try {
    const dir = dataDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'search-debug.json'), JSON.stringify(d, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}

/**
 * 统一解析入口：输入任意线索 → 返回可入库的主播候选列表。
 * 这是「搜索主播」对话框与「主播ID 定位」共用的后端。
 */
export async function searchDouyinUsers(keyword: string): Promise<DouyinSearchResult> {
  const kw = (keyword || '').trim()
  if (!kw) return { ok: false, users: [], error: '请输入主播昵称、抖音号、作品链接或主播主页链接' }

  const cookie = getCookie('douyin')
  const cls = classify(kw)
  L.info('[resolve] 输入分类', { kw, type: cls.type, needCookie: !cookie })

  try {
    /* 1) 主页链接 / 裸 sec_uid —— 直接 profile/other 补全 */
    if (cls.type === 'userUrl' || cls.type === 'secUid') {
      if (!cookie) {
        return { ok: false, users: [], needCookie: true, error: '需要抖音登录态才能读取主播详情（点「登录抖音」即可）' }
      }
      const u = await fetchProfile(cls.value, cookie)
      if (!u) return { ok: false, users: [], error: '读取主播详情失败（Cookie 可能已过期）' }
      return { ok: true, users: [u] }
    }

    /* 2) 直播链接 —— 直播页 SSR 兜底（免登录） */
    if (cls.type === 'liveUrl') {
      const u = await userFromLivePage(cls.value)
      if (u && (u.nickname || u.secUid)) {
        if (u.secUid) {
          // 有 sec_uid 就顺手用 profile 补全（需登录，失败也不影响）
          if (cookie) {
            const p = await fetchProfile(u.secUid, cookie)
            if (p) return { ok: true, users: [p] }
          }
        }
        return { ok: true, users: [u] }
      }
      if (cookie) {
        // 直播页拿不到，退回签名搜索
        const users = await resolveSearch(kw, cookie)
        if (users.length) return { ok: true, users }
      }
      return {
        ok: false,
        users: [],
        needCookie: !cookie,
        error: cookie ? '该直播链接当前打不开（主播可能已改名或不存在）' : '需要抖音登录态才能定位该主播'
      }
    }

    /* 3) 作品链接 / 作品ID —— 免登录反查作者 */
    if (cls.type === 'videoUrl' || cls.type === 'videoId') {
      const u = await resolveVideo(cls.value)
      if (u) return { ok: true, users: [u] }
      if (cookie) {
        // 视频反查失败，尝试当「主播名/抖音号」再搜一次
        const users = await resolveSearch(kw, cookie)
        if (users.length) return { ok: true, users }
      }
      return { ok: false, users: [], error: '未能从作品反查到主播（链接可能失效或需登录）' }
    }

    /* 4) 主播昵称 / 抖音号 —— 有登录走签名搜索；无登录走直播页兜底 */
    if (cls.type === 'nameOrId') {
      if (cookie) {
        const users = await resolveSearch(kw, cookie)
        if (users.length) {
          // 抖音号精确命中排最前
          users.sort((a, b) => {
            const ea = a.douyinId.toLowerCase() === kw.toLowerCase() ? 0 : 1
            const eb = b.douyinId.toLowerCase() === kw.toLowerCase() ? 0 : 1
            return ea - eb
          })
          return { ok: true, users }
        }
        // 搜索无结果：若输入像抖音号/手柄，再试直播页兜底
        const looksLikeId = /^[A-Za-z0-9_.]+$/.test(kw) && !/[\u4e00-\u9fa5]/.test(kw)
        if (looksLikeId) {
          const u = await userFromLivePage(kw)
          if (u && (u.nickname || u.secUid)) return { ok: true, users: [u] }
        }
        return { ok: true, users: [], error: '没有搜到匹配的主播（换个关键词，或确认抖音号拼写）' }
      }
      // 无登录：只有像抖音号/手柄的输入才能走直播页兜底
      const looksLikeId = /^[A-Za-z0-9_.]+$/.test(kw) && !/[\u4e00-\u9fa5]/.test(kw)
      if (looksLikeId) {
        const u = await userFromLivePage(kw)
        if (u && (u.nickname || u.secUid)) return { ok: true, users: [u] }
      }
      return {
        ok: false,
        users: [],
        needCookie: true,
        error: '抖音搜索需要登录态。若是「主播昵称」请先登录；若是「抖音号/手柄」可稍后再试，或登录后更稳。'
      }
    }

    return { ok: false, users: [], error: '无法识别输入' }
  } catch (e: any) {
    const msg = `定位主播失败：${e?.message ?? e}`
    L.error('[resolve] 异常', { kw, msg })
    dumpDebug({ kw, cls: cls.type, msg, ts: new Date().toISOString() })
    return { ok: false, users: [], error: msg }
  }
}
