/* 诊断：加载抖音搜索页，输出页面实际状态（不做任何业务） */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-gpu-sandbox')
if (process.env.LR_NOSW) app.commandLine.appendSwitch('disable-features', 'RenderingFallback,BackForwardCache')
if (process.env.LR_UD) app.setPath('userData', process.env.LR_UD)

const KW = process.env.LR_KW || 'qjandu17177'
const OUT = process.env.LR_OUT || 'C:/Users/Administrator/live-review/dist/_elpage.json'
const POLL = process.env.LR_POLL === '1'
const PARTITION = process.env.LR_PART || ''

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 860,
    webPreferences: { sandbox: true, spellcheck: false, nodeIntegration: false, contextIsolation: true, partition: PARTITION || undefined }
  })
  // 注入登录态 Cookie
  try {
    const cred = JSON.parse(fs.readFileSync('C:/Users/Administrator/live-review/dist/LiveReview-Data/credentials.json', 'utf8'))
    const cookie = cred.douyin && cred.douyin.cookie
    if (cookie) {
      for (const part of cookie.split(';')) {
        const p = part.trim()
        const i = p.indexOf('=')
        if (i <= 0) continue
        try {
          await win.webContents.session.cookies.set({
            url: 'https://www.douyin.com', name: p.slice(0, i).trim(),
            value: p.slice(i + 1).trim(), domain: '.douyin.com', path: '/'
          })
        } catch {}
      }
    }
  } catch (e) { console.error('cookie inject failed', e) }
  try {
    const ua = win.webContents.getUserAgent().replace(/\s*(Electron|live-review|LiveReview)\/[\d.]+/gi, '')
    win.webContents.setUserAgent(ua)
  } catch {}
  try {
    await win.loadURL('https://www.douyin.com/search/' + encodeURIComponent(KW) + '?type=user')
  } catch (e) { /* ignore in-flight */ }

  let info = {}
  if (POLL) {
    let last = {}
    for (let i = 0; i < 22; i++) {
      await new Promise((r) => setTimeout(r, 700))
      try {
        last = await win.webContents.executeJavaScript(`(() => {
          let n = 0
          for (const a of document.querySelectorAll('a[href*="/user/MS4w"]')) n++
          return { n, anchors: document.querySelectorAll('a').length, title: document.title }
        })()`)
      } catch (e) { last = { exc: String(e).slice(0, 100) } }
      if (i % 4 === 0) console.error('poll', i, JSON.stringify(last))
      if (last.n >= 3) break
    }
    info = last
  } else {
    await new Promise((r) => setTimeout(r, 12000))
    try {
      info = await win.webContents.executeJavaScript(`(() => {
        const anchors = [...document.querySelectorAll('a')]
        const userLinks = anchors.map(a => a.getAttribute('href') || '').filter(h => h.includes('/user/'))
        return {
          url: location.href, title: document.title,
          text: (document.body ? document.body.innerText : '').slice(0, 800),
          anchorCount: anchors.length,
          userLinks: [...new Set(userLinks)].slice(0, 10)
        }
      })()`)
    } catch (e) { info = { exc: String(e) } }
  }
  fs.writeFileSync(OUT, JSON.stringify(info, null, 2), 'utf8')
  app.exit(0)
})
