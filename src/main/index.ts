/**
 * 主进程入口。
 *
 * 职责边界：只做「进程级」的事——启动兜底开关、单实例、窗口、托盘、生命周期，
 * 以及把各 service 串起来。任何业务逻辑都不写在这里。
 */
import { app, BrowserWindow, Menu, Tray, nativeImage, shell, protocol } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EVT } from '../shared/ipc'
import { registerIpc } from './ipc'
import * as store from './store'
import { initLogger, log, pruneLogs } from './logger'
import { detectFfmpeg, probeDuration, probeMedia } from './ffmpeg'
import * as monitor from './monitor'
import * as streamers from './streamers'
import * as recorder from './recorder'
import * as capture from './capture'
import * as disk from './disk'
import { danmakuHub } from './danmaku-hub'
import { stopRelay } from './relay'
import { scheduleSweep, sweepPortableTemp } from './cleanup'

/*
 * 启动稳定性（踩过的坑，别删）：
 * 部分机器 / 受限会话下，Chromium 的 GPU 子进程无法在沙箱里启动，会反复崩溃，
 * 重试到上限后浏览器进程直接 FATAL 退出。现象是「双击没反应 / 一闪就没了」，
 * 退出码 -2147483645，日志里是 `GPU process isn't usable. Goodbye.`。
 *
 * 实测（Electron 44）：`--disable-gpu` 治不了；下面这个开关才是有效的，
 * 它只关掉 GPU 子进程的沙箱，主进程与渲染进程的沙箱不受影响。
 */
app.commandLine.appendSwitch('disable-gpu-sandbox')

// 进一步兜底：本项目界面很轻，用不上硬件加速，默认关掉换取最大兼容性。
// 显卡驱动正常、想要硬件加速的话，设环境变量 LR_GPU=1 即可恢复。
if (process.env.LR_GPU !== '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
}

/*
 * 数据落地（关键）：把整个 Chromium 用户数据目录也指到便携数据目录里。
 * 不设的话，Electron 默认把缓存 / Cookie / Local Storage / GPUCache 写到
 * C:\Users\<你>\AppData\Roaming\live-review —— 便携版的运行数据就漏到 C 盘了。
 * 指过去之后：应用自己的 JSON（store.ts → LiveReview-Data 根）与浏览器侧数据
 * （LiveReview-Data\userData）都在 exe 同目录下，拷走 exe 即拷走全部。
 * 必须在 app.ready 之前调用才生效。
 */
try {
  const portableRoot = store.portableDataRoot()
  if (portableRoot) {
    const ud = path.join(portableRoot, 'userData')
    fs.mkdirSync(ud, { recursive: true })
    app.setPath('userData', ud)
  }
} catch {
  /* 便携目录不可写等场景保持默认 userData，不阻塞启动 */
}

const PRELOAD = path.join(__dirname, '../preload/index.js')
const RENDERER_DIR = path.join(__dirname, '../renderer')
const VITE_DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL']

/** 自定义渲染层协议名。
 *  为什么需要它：打包后默认走 `loadFile()`，渲染层起源是 `file://`；
 *  Chromium 把 `file://` 当作 opaque 起源，会禁用 MSE 序列模式 + blob Worker，
 *  导致 mpegts.js / hls.js 完全无法喂流，播放器黑屏。
 *  这里注册一个 secure 起源 `liver://`，把 out/renderer 里的文件当正常页面送出，
 *  MSE 序列模式 + blob Worker 都恢复正常。 */
const RENDERER_SCHEME = 'liver'

/** 必须在 app.ready 之前调用，scheme 才能在 protocol.handle 中生效 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true
    }
  }
])

/** 简易 MIME 映射（够用即可：Vite build 产物类型有限） */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8'
}

function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

/** 把 RENDERER_DIR 内的相对路径安全映射到磁盘路径，禁止越界 */
function resolveRendererFile(urlObj: URL): string | null {
  let p = decodeURIComponent(urlObj.pathname)
  if (p === '/' || p === '') p = '/index.html'
  const target = path.resolve(RENDERER_DIR, '.' + p)
  const root = path.resolve(RENDERER_DIR) + path.sep
  if (!target.startsWith(root) && target !== path.resolve(RENDERER_DIR)) return null
  return target
}

let win: BrowserWindow | null = null
let tray: Tray | null = null
/** 真正退出（而非缩到托盘） */
let quitting = false

/* ============================ 单实例 ============================ */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
    }
  })
}

/* ============================ 图标 ============================ */

function iconPath(): string | null {
  const candidates = [
    path.join(process.resourcesPath || '', 'icon.ico'),
    path.join(process.resourcesPath || '', 'icon.png'),
    path.join(app.getAppPath(), 'resources', 'icon.ico'),
    path.join(app.getAppPath(), 'resources', 'icon.png'),
    path.join(__dirname, '../../resources/icon.ico'),
    path.join(__dirname, '../../resources/icon.png')
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

function appIcon(): Electron.NativeImage | undefined {
  const p = iconPath()
  if (!p) return undefined
  const img = nativeImage.createFromPath(p)
  return img.isEmpty() ? undefined : img
}

/* ============================ 窗口 ============================ */

function createWindow(): void {
  win = new BrowserWindow({
    title: '直播复盘工具',
    width: 1240,
    height: 800,
    minWidth: 1024,
    minHeight: 660,
    show: false,
    frame: false, // 自绘标题栏（与原版一致的观感）
    backgroundColor: '#fdfcf9',
    icon: appIcon(),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // 关闭 webSecurity：
      // 1) liver:// 是 secure origin，去 fetch http://127.0.0.1:中继 在某些 Chromium 版本
      //    仍被视作 mixed content 导致 mpegts/hls 的 XHR/fetch 静默被拦（黑屏但 0 报错）。
      // 2) 单窗口应用且仅访问自家 127.0.0.1 中继，安全代价可控。
      // 注：liver:// secure origin 仍保留（用于 MSE 序列模式 + 非 opaque origin）。
      webSecurity: false,
      // 同上：明确允许 secure 起源加载非 secure 子资源
      allowRunningInsecureContent: true
    }
  })

  win.once('ready-to-show', () => {
    if (!process.env.LR_SMOKE) win?.show()
  })

  const emitMax = (): void => win?.webContents.send(EVT.windowMaximized, win.isMaximized())
  win.on('maximize', emitMax)
  win.on('unmaximize', emitMax)

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  // 关闭 → 按配置缩到托盘，还是直接退出
  win.on('close', (e) => {
    if (quitting) return
    const cfg = store.getConfig()
    if (cfg.closeBehavior === 'tray' && cfg.minimizeToTray) {
      e.preventDefault()
      win?.hide()
      win?.webContents.send(EVT.appCloseRequested)
    }
  })

  win.on('closed', () => {
    win = null
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // 生产模式：经 liver:// 协议加载渲染层，避开 file:// 的 opaque-origin 限制
    win.loadURL(`${RENDERER_SCHEME}://./index.html`)
  }
}

/* ============================ 托盘 ============================ */

function createTray(): void {
  const p = iconPath()
  if (!p) return
  let img = nativeImage.createFromPath(p)
  if (img.isEmpty()) return
  img = img.resize({ width: 16, height: 16 })

  try {
    tray = new Tray(img)
  } catch (e: any) {
    log('app').warn('托盘创建失败（不影响主功能）', e?.message ?? e)
    return
  }

  tray.setToolTip('直播复盘工具')

  const buildMenu = (): Menu => {
    return Menu.buildFromTemplate([
      {
        label: '显示主界面',
        click: () => {
          if (!win) createWindow()
          win?.show()
          win?.focus()
        }
      },
      { type: 'separator' },
      {
        label: '开始监控',
        click: () => monitor.start()
      },
      {
        label: '停止监控',
        click: () => monitor.stop()
      },
      {
        label: '停止全部录制',
        click: () => recorder.stopAll()
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => quitApp()
      }
    ])
  }

  tray.setContextMenu(buildMenu())
  tray.on('double-click', () => {
    if (!win) createWindow()
    win?.show()
    win?.focus()
  })
}

function quitApp(): void {
  quitting = true
  app.quit()
}

/* ============================ 启动 ============================ */

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)

  // 注册 liver:// 协议处理：把 out/renderer 下的文件按路径送出
  // 路径越界或文件不存在返回 403/404，避免被当通用文件代理
  protocol.handle(RENDERER_SCHEME, async (req) => {
    try {
      const u = new URL(req.url)
      const target = resolveRendererFile(u)
      if (!target) return new Response('forbidden', { status: 403 })
      const data = await fs.promises.readFile(target)
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': mimeOf(target), 'Cache-Control': 'no-cache' }
      })
    } catch (e: unknown) {
      const msg = (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'not found' : String(e)
      return new Response(msg, { status: 404 })
    }
  })

  // 数据 / 日志
  initLogger(path.join(store.dataDir(), 'logs'))
  pruneLogs(14)
  const L = log('app')
  L.info('启动', {
    version: app.getVersion(),
    electron: process.versions.electron,
    portable: !!store.portableDataRoot(),
    dataDir: store.dataDir()
  })

  store.migrateLegacy()
  const cfg = store.getConfig()

  // ffmpeg 体检（失败不阻塞启动，界面上会提示）
  const ff = detectFfmpeg()
  L.info('ffmpeg', ff.source, ff.version || '(未找到)')

  // 开机自启状态与配置对齐（只在打包后有效）
  try {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!cfg.autoStartup, args: [] })
  } catch {
    /* ignore */
  }

  registerIpc(() => win)
  // 搜索自测模式：不建主窗口/托盘，最小化环境干扰，便于定位搜索窗口问题
  if (!process.env.LR_SEARCH_TEST) {
    createWindow()
    createTray()
  }

  // 服务启动：监控 + 弹幕订阅 + 磁盘看护
  streamers.syncDanmaku()
  monitor.initFromStreamers()
  monitor.start()
  disk.start()

  // 运行形态自检：便携版（单文件 exe）会把整个应用解压进 %TEMP% 再从那里运行。
  // 「未签名程序 + 从系统临时目录运行」是游戏反作弊的高危特征
  // （实测：开着便携版启动三角洲行动必报 1067105，关掉即正常）。
  // 绿色版不受影响，这里只在便携形态下记一条告警，方便日后自查，不阻断运行。
  try {
    const tmp = os.tmpdir().toLowerCase().replace(/[\\/]+$/, '')
    const exe = process.execPath.toLowerCase()
    if (exe.startsWith(tmp + '\\') || exe.startsWith(tmp + '/')) {
      L.warn(`便携模式：应用正从系统临时目录运行（${process.execPath}）`)
      L.warn('该形态易被游戏反作弊判为高危环境，建议改用绿色版：把 zip 解压到固定目录后运行 LiveReview.exe')
    }
  } catch {
    /* 自检失败不影响启动 */
  }

  // 便携版每次启动都会把自己解压进临时目录；被强杀就会留下整份残留。
  // 正常模式延迟几秒后台跑一次，不阻塞界面（详见 cleanup.ts）。
  // 自检模式**不**在这里跑：sweep 是异步分片执行的（目录之间让出事件循环），
  // 2.5 秒的冒烟退出会把没跑完的它掐掉，所以改由下面的冒烟钩子 await 完再退出。
  if (!process.env.LR_SMOKE) scheduleSweep(4000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else {
      win?.show()
      win?.focus()
    }
  })

  // 自测钩子：LR_SMOKE=1 时不显示窗口，2.5 秒后自检并退出
  if (process.env.LR_SMOKE) {
    setTimeout(async () => {
      const lines: string[] = []
      lines.push(`[smoke] ffmpeg=${ff.source} ${ff.version}`)
      lines.push(`[smoke] dataDir=${store.dataDir()}`)
      lines.push(`[smoke] streamers=${store.getStreamers().length}`)

      // 附加：探测某个媒体文件（验证不依赖 ffprobe 的兜底路径）
      const probeTarget = process.env.LR_PROBE
      if (probeTarget) {
        try {
          const [info, dur] = await Promise.all([
            probeMedia(probeTarget),
            probeDuration(probeTarget)
          ])
          lines.push(`[probe] file=${probeTarget}`)
          lines.push(`[probe] ${JSON.stringify({ ...info, durationMsFromProbe: dur })}`)
        } catch (e: any) {
          lines.push(`[probe] failed: ${e?.message ?? e}`)
        }
      }

      try {
        const probe: any = await win?.webContents.executeJavaScript(
          `({ keys: Object.keys(window.api || {}).length, hasEl: !!document.querySelector('.el-container, #app > *') })`
        )
        lines.push(`[smoke] preload api keys=${probe?.keys} rendered=${probe?.hasEl}`)
      } catch (e: any) {
        lines.push(`[smoke] renderer check failed: ${e?.message ?? e}`)
      }

      // 临时残留回收：await 到跑完，结果写进 smoke.log 好让验收断言。
      // 外面再套一层超时，保证「清扫再怎么慢」也不会把冒烟退出卡住。
      try {
        const sw = await Promise.race([
          sweepPortableTemp(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('sweep timeout')), 30_000))
        ])
        lines.push(
          `[cleanup] candidates=${sw.scanned} reclaimed=${sw.cleaned.length} freedMB=${(sw.freedBytes / 1048576).toFixed(0)} own=${sw.ownPluginsDir ?? 'none'} timedOut=${sw.timedOut}`
        )
        lines.push(
          `[cleanup] releasedMB=${(sw.releasedBytes / 1048576).toFixed(0)} ownDirRemoved=${sw.releasedDir}`
        )
        for (const c of sw.cleaned) lines.push(`[cleanup] reclaimed ${c.path} (${c.mb.toFixed(0)} MB, ${c.ms} ms)`)
        for (const s of sw.skipped) lines.push(`[cleanup] skipped ${s.path} :: ${s.reason}`)
      } catch (e: any) {
        lines.push(`[cleanup] sweep failed: ${e?.message ?? e}`)
      }

      fs.writeFileSync(path.join(store.dataDir(), 'smoke.log'), lines.join('\n'), 'utf8')
      console.log(lines.join('\n'))
      quitApp()
    }, 2500)
  }

  // 搜索自测钩子：LR_SEARCH_TEST=<关键词> 直接跑一次抖音搜索并落盘，供打包前验证
  if (process.env.LR_SEARCH_TEST) {
    const kw = process.env.LR_SEARCH_TEST
    const outFile = process.env.LR_SEARCH_OUT || path.join(store.dataDir(), 'search-test.log')
    void (async () => {
      let result: unknown
      try {
        const { searchDouyinUsers } = await import('./douyin-search')
        result = await searchDouyinUsers(kw)
      } catch (e: any) {
        result = { ok: false, users: [], error: e?.message ?? String(e) }
      }
      try {
        fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8')
      } catch (e: any) {
        console.error('write search-test failed', e?.message ?? e)
      }
      quitApp()
    })()
  }
})

/* ============================ 退出 ============================ */

app.on('window-all-closed', () => {
  if (quitting) return
  const cfg = store.getConfig()
  // 常驻托盘时不退出
  if (cfg.closeBehavior === 'tray' && cfg.minimizeToTray) return
  quitApp()
})

app.on('before-quit', () => {
  quitting = true
  log('app').info('退出中：停止录制 / 监控 / 中继')
  try {
    recorder.stopAll()
  } catch {
    /* ignore */
  }
  try {
    capture.stopCapture()
  } catch {
    /* ignore */
  }
  try {
    monitor.stop()
  } catch {
    /* ignore */
  }
  try {
    disk.stop()
  } catch {
    /* ignore */
  }
  try {
    danmakuHub.stopAll()
  } catch {
    /* ignore */
  }
  try {
    stopRelay()
  } catch {
    /* ignore */
  }
  if (tray) {
    tray.destroy()
    tray = null
  }
})
