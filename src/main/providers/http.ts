/** 统一的 HTTP 请求封装：集中处理 UA / Referer / Cookie / 超时，便于各平台复用。 */
import { PlatformId } from '../../shared/types'

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export interface RequestOptions {
  headers?: Record<string, string>
  cookie?: string
  referer?: string
  timeoutMs?: number
  method?: 'GET' | 'POST'
  body?: string
}

export interface HttpResponse {
  status: number
  text: string
  headers: Record<string, string>
  json<T = any>(): T
}

export async function request(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  }
  if (opts.referer) headers.Referer = opts.referer
  if (opts.cookie) headers.Cookie = opts.cookie
  Object.assign(headers, opts.headers || {})

  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15000)
  })

  const text = await res.text()
  const out: Record<string, string> = {}
  res.headers.forEach((v: string, k: string) => {
    out[k.toLowerCase()] = v
  })

  return {
    status: res.status,
    text,
    headers: out,
    json<T = any>(): T {
      return JSON.parse(text) as T
    }
  }
}

/** 各平台默认 Referer，避免被拦。 */
export const DEFAULT_REFERER: Partial<Record<PlatformId, string>> = {
  bilibili: 'https://live.bilibili.com/',
  douyu: 'https://www.douyu.com/',
  huya: 'https://www.huya.com/',
  douyin: 'https://live.douyin.com/',
  kuaishou: 'https://live.kuaishou.com/'
}

/** 从形如 b=1; c=2 的 cookie 串里取某一项 */
export function pickCookie(cookie: string | undefined, key: string): string | null {
  if (!cookie) return null
  const m = new RegExp(`(?:^|;\\s*)${key}=([^;]*)`).exec(cookie)
  return m ? m[1] : null
}

/** 生成随机 buvid3（B 站风控用，避免未带 cookie 时直接被拒） */
export function randomBuvid(): string {
  const hex = '0123456789ABCDEF'
  let s = ''
  for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)]
  return `${s}infoc`
}
