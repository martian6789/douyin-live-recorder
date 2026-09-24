/**
 * 抖音「我的关注」列表 —— 一键把关注过的主播全倒进主播库。
 *
 * 为什么这条路最好用：抖音网页版「关注」页给的每个直播入口都是
 * https://www.douyin.com/follow/live/<web_rid>，而 web_rid 对主播来说是长期固定的
 * ——实测主播没开播时 live.douyin.com/<web_rid> 照样能解析出他的名字。
 * 也就是说，只要拿到一次，这个号就能一直用下去。
 *
 * 关注列表接口 `aweme/v1/web/user/following/list` 会带上每个用户的 room_id，
 * 但那是 19 位**内部 id**，直接拼进 live.douyin.com 只会得到一个没有主播数据的空壳页。
 * 所以拿到的候选号一律过 normalizeRoomId() 校验，通不过的退回「按主页监控」。
 */
import { request } from './providers/http'
import { getCookie } from './store'
import { normalizeRoomId } from './providers/douyin'
import { log } from './logger'
import type { DouyinSearchUser } from '../shared/types'

const L = log('douyin-follow')

const SELF_API = 'https://www.douyin.com/aweme/v1/web/user/profile/self/'
const FOLLOW_API = 'https://www.douyin.com/aweme/v1/web/user/following/list/'

function pickAvatar(node: any): string | undefined {
  if (!node || typeof node !== 'object') return undefined
  for (const k of ['avatar_thumb', 'avatar_medium', 'avatar_larger']) {
    const list = node[k]?.url_list
    if (Array.isArray(list)) {
      const hit = list.find((u: unknown) => typeof u === 'string' && u.startsWith('http'))
      if (hit) return hit
    }
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

export interface DouyinFollowingResult {
  ok: boolean
  users: DouyinSearchUser[]
  error?: string
  needCookie?: boolean
  /** 本次扫描了多少个关注 */
  scanned?: number
}

/** 取自己的 sec_uid（关注列表要用它做查询参数） */
async function mySecUid(cookie: string): Promise<string | undefined> {
  try {
    const res = await request(`${SELF_API}?${new URLSearchParams({
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      cookie_enabled: 'true',
      platform: 'PC'
    }).toString()}`, { cookie, referer: 'https://www.douyin.com/', timeoutMs: 15000 })
    const j = res.json<any>()
    if (j?.status_code === 0) return j?.user?.sec_uid
    L.warn('[self] 接口拒绝', { status_code: j?.status_code })
  } catch (e: any) {
    L.warn('[self] 失败', { msg: e?.message ?? e })
  }
  return undefined
}

export async function fetchDouyinFollowing(maxPages = 10): Promise<DouyinFollowingResult> {
  const cookie = getCookie('douyin')
  if (!cookie) {
    return {
      ok: false,
      users: [],
      needCookie: true,
      error: '需要抖音登录态：请先登录抖音并导入 Cookie，才能读取你的关注列表'
    }
  }

  const secUid = await mySecUid(cookie)
  if (!secUid) {
    return {
      ok: false,
      users: [],
      needCookie: true,
      error: '读不到自己的抖音账号（Cookie 可能过期），请重新登录抖音后再试'
    }
  }

  const map = new Map<string, DouyinSearchUser>()
  let maxTime = 0
  let scanned = 0

  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      sec_user_id: secUid,
      count: '20',
      max_time: String(maxTime),
      source: '1',
      offset: '0',
      cookie_enabled: 'true',
      platform: 'PC'
    })
    let j: any
    try {
      const res = await request(`${FOLLOW_API}?${qs.toString()}`, {
        cookie,
        referer: 'https://www.douyin.com/follow',
        timeoutMs: 15000
      })
      j = res.json<any>()
    } catch (e: any) {
      const msg = `读取关注列表失败：${e?.message ?? e}`
      L.error('[follow] 请求异常', { page, msg })
      // 已经拿到一部分就把已有的返回，不浪费
      return { ok: map.size > 0, users: [...map.values()], error: msg, scanned }
    }

    if (typeof j?.status_code === 'number' && j.status_code !== 0) {
      const msg = String(j?.status_msg ?? '')
      const needCookie = j.status_code === 8 || /登录|login/i.test(msg)
      L.error('[follow] 接口拒绝', { status_code: j.status_code, msg })
      return {
        ok: map.size > 0,
        users: [...map.values()],
        needCookie,
        error: needCookie ? '抖音要求重新登录（Cookie 过期）' : `抖音返回异常：${j.status_code} ${msg}`,
        scanned
      }
    }

    const list: any[] = j?.followings ?? []
    scanned += list.length
    for (const it of list) {
      const u = it?.user_info ?? it
      const sec = typeof u?.sec_uid === 'string' ? u.sec_uid : ''
      const nick = typeof u?.nickname === 'string' ? u.nickname : ''
      if (!sec || !nick || sec === '$undefined' || nick === '$undefined') continue
      if (map.has(sec)) continue
      map.set(sec, {
        secUid: sec,
        nickname: nick,
        douyinId:
          (typeof u?.unique_id === 'string' && u.unique_id !== '0' && u.unique_id) ||
          (typeof u?.short_id === 'string' && u.short_id !== '0' && u.short_id) ||
          '',
        signature: typeof u?.signature === 'string' ? u.signature : '',
        followers: typeof u?.follower_count === 'number' ? u.follower_count : undefined,
        avatar: pickAvatar(u),
        living: u?.live_status === 1 ? true : undefined,
        // 这里先记原始候选，稍后统一校验
        roomId: firstNum(u, ['web_rid']) ?? firstNum(u, ['room_id']),
        homeUrl: `https://www.douyin.com/user/${sec}`
      })
    }

    if (!j?.has_more || !j?.max_time) break
    maxTime = Number(j.max_time) || 0
    if (!maxTime) break
  }

  const users = [...map.values()]
  L.info('[follow] 读到关注', { scanned, uniq: users.length, withRoom: users.filter((u) => u.roomId).length })

  // 校验候选房间号：关注列表给的多半是 19 位内部 id，不能直接用于 live.douyin.com
  const todo = users.filter((u) => u.roomId)
  const queue = [...todo]
  const workers = new Array(Math.min(3, queue.length)).fill(0).map(async () => {
    for (;;) {
      const u = queue.shift()
      if (!u) return
      const ok = await normalizeRoomId(u.roomId!)
      if (ok) {
        u.roomId = ok
        u.roomUrl = `https://www.douyin.com/follow/live/${ok}`
        u.living = true
      } else {
        // 校验不过：多半是内部 id 或未开播，退回按主页监控
        u.roomId = undefined
        u.living = undefined
      }
    }
  })
  await Promise.all(workers)

  L.info('[follow] 校验后可用直播间号', { count: users.filter((u) => u.roomId).length })
  return { ok: true, users, scanned }
}
