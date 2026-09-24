/**
 * 抖音登录：内置一个浏览器窗口让用户扫码/验证码登录，再从会话里把 Cookie 取出来。
 *
 * 为什么不用「手动复制 Cookie」：抖音搜索是登录态接口（未登录返回 2483），
 * 让用户 F12 找请求头成本太高。这里用 Electron 自己的持久化 session，
 * 登录态会跟着本机留存，下次打开软件还在。
 */
import { BrowserWindow, session } from 'electron'
import { setCredential } from './store'
import { log } from './logger'

const L = log('douyin-login')

let win: BrowserWindow | null = null

export function openDouyinLogin(): boolean {
  if (win && !win.isDestroyed()) {
    win.focus()
    return true
  }

  win = new BrowserWindow({
    title: '登录抖音（登录完成后回到软件点「导入 Cookie」）',
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false
    }
  })

  win.on('closed', () => {
    win = null
  })

  // 登录页偶尔会被站方的 window.open 拦截逻辑影响，放行同源弹窗即可
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow' }))

  void win.loadURL('https://www.douyin.com')
  L.info('已打开抖音登录窗口')
  return true
}

/** 从默认会话里取出 douyin.com 域下的全部 Cookie，拼接成请求头格式 */
export async function importDouyinCookie(): Promise<{ ok: boolean; length?: number; error?: string }> {
  try {
    const ses = session.defaultSession
    const list = await ses.cookies.get({ domain: 'douyin.com' })
    if (!list?.length) {
      L.warn('会话里读不到抖音 Cookie')
      return { ok: false, error: '没有读到抖音 Cookie：请先在弹出窗口里完成登录（登录成功后页面会显示你的头像），再回来点导入。' }
    }

    const map = new Map<string, string>()
    for (const c of list) map.set(c.name, c.value)
    const cookie = [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')

    setCredential('douyin', cookie)
    L.info('已导入抖音 Cookie', { items: map.size, length: cookie.length })

    // 登录态已拿到，窗口可以关掉了
    if (win && !win.isDestroyed()) win.close()
    return { ok: true, length: cookie.length }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    L.error('导入 Cookie 失败', msg)
    return { ok: false, error: `导入失败：${msg}` }
  }
}
