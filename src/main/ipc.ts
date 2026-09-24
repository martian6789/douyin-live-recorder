/**
 * IPC 注册层：主进程的唯一对外「配电盘」。
 *
 * 约定：
 * - 通道名一律取自 shared/ipc.ts（与原版同名的那些），便于对照排查。
 * - 每个 handler 都只做「转发 + 必要校验」，业务规则留在各自 service 里。
 * - 服务发的事件统一在文件末尾一处订阅，再广播给渲染进程，避免散落各处。
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { EVT, IPC } from '../shared/ipc'
import {
  CAPTURE_SOURCES,
  PLATFORMS,
  QUALITY_PRESETS,
  type AppConfig,
  type CaptureConfig,
  type HistoryItem,
  type PlatformId,
  type RecordTaskState,
  type Streamer,
  type SystemInfo,
  type TranscribeSettings
} from '../shared/types'
import * as store from './store'
import { getProvider, listPlatforms } from './providers'
import { DEFAULT_REFERER } from './providers/http'
import { detectFfmpeg } from './ffmpeg'
import { getLogDir, log } from './logger'
import * as streamers from './streamers'
import * as monitor from './monitor'
import * as recorder from './recorder'
import { danmakuHub } from './danmaku-hub'
import * as library from './library'
import * as merger from './merger'
import * as converter from './converter'
import * as capture from './capture'
import * as transcribe from './transcribe'
import * as disk from './disk'
import { notify } from './notify'
import { proxied, startRelay, relayPort, transcoded } from './relay'
import { renderTemplate, templateVariables, validateTemplate } from './template'
import { searchDouyinUsers } from './douyin-search'
import { fetchDouyinFollowing } from './douyin-follow'
import { openDouyinLogin, importDouyinCookie } from './douyin-login'
import type { DouyinSearchUser } from '../shared/types'

type Sender = (channel: string, payload?: unknown) => void

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const L = log('ipc')
  const push: Sender = (channel, payload) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  /* ==================================================================== app */

  ipcMain.handle(IPC.appGetInfo, () => ({
    version: app.getVersion(),
    name: app.getName(),
    isPackaged: app.isPackaged
  }))

  ipcMain.handle(IPC.appGetAutoStartup, () => {
    try {
      return app.getLoginItemSettings().openAtLogin
    } catch {
      return false
    }
  })

  ipcMain.handle(IPC.appSetAutoStartup, (_e, enabled: boolean) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled, args: [] })
      store.setConfig({ autoStartup: !!enabled })
      emitConfig()
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(IPC.appCheckVersionUpdate, async () => {
    const current = app.getVersion()
    const url = process.env.LR_UPDATE_URL
    if (!url) {
      return { current, latest: current, hasUpdate: false, error: '未配置更新源（LR_UPDATE_URL）' }
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      const data: any = await res.json()
      const latest = String(data?.version ?? current)
      const cmp = (a: string, b: string): number => {
        const pa = a.split('.').map(Number)
        const pb = b.split('.').map(Number)
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const d = (pa[i] || 0) - (pb[i] || 0)
          if (d) return d
        }
        return 0
      }
      return {
        current,
        latest,
        hasUpdate: cmp(latest, current) > 0,
        url: data?.url,
        notes: data?.notes
      }
    } catch (e: any) {
      return { current, latest: current, hasUpdate: false, error: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.appCheckFirstRun, () => {
    const st = store.readAppState('firstRun', { completed: false })
    return !st.completed
  })

  ipcMain.handle(IPC.appSetFirstRunCompleted, () => {
    store.writeAppState('firstRun', { completed: true, at: Date.now() })
    return true
  })

  ipcMain.handle(IPC.appOpenExternal, async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url || '')) return false
    await shell.openExternal(url)
    return true
  })

  ipcMain.handle(IPC.appOpenLogDirectory, async () => {
    const dir = getLogDir()
    fs.mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
    return dir
  })

  ipcMain.handle(IPC.appShowInFolder, (_e, target: string) => {
    library.showInFolder(target)
    return true
  })

  ipcMain.handle(IPC.appQuit, () => {
    app.quit()
  })

  /* ================================================================= window */

  const windowOf = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender) ?? getWindow()

  ipcMain.handle(IPC.windowMinimize, (e, behavior?: 'taskbar' | 'tray') => {
    const win = windowOf(e)
    if (!win) return
    const cfg = store.getConfig()
    const mode = behavior ?? (cfg.closeBehavior === 'tray' && cfg.minimizeToTray ? 'tray' : 'taskbar')
    if (mode === 'tray') win.hide()
    else win.minimize()
  })

  ipcMain.handle(IPC.windowToggleMaximize, (e) => {
    const win = windowOf(e)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })

  ipcMain.handle(IPC.windowClose, (e) => {
    windowOf(e)?.close()
  })

  ipcMain.handle(IPC.windowIsMaximized, (e) => windowOf(e)?.isMaximized() ?? false)

  /* ================================================================= config */

  ipcMain.handle(IPC.configGet, () => store.getConfig())

  ipcMain.handle(IPC.configSet, (_e, patch: Partial<AppConfig>) => {
    const next = store.setConfig(patch ?? {})
    afterConfigChange(patch ?? {})
    return next
  })

  ipcMain.handle(IPC.configSetMultiple, (_e, patch: Partial<AppConfig>) => {
    const next = store.setConfig(patch ?? {})
    afterConfigChange(patch ?? {})
    return next
  })

  ipcMain.handle(IPC.configReset, () => {
    const next = store.resetConfig()
    afterConfigChange(next as Partial<AppConfig>)
    return next
  })

  ipcMain.handle(IPC.configSelectDirectory, async (_e, title?: string) => {
    const res = await dialog.showOpenDialog({
      title: title || '选择目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC.configOpenSaveDirectory, async () => {
    const dir = store.getConfig().outputDir
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
    return true
  })

  ipcMain.handle(IPC.configGetTemplateVariables, () => templateVariables())

  ipcMain.handle(IPC.configValidateTemplate, (_e, tpl: string) => validateTemplate(tpl))

  ipcMain.handle(IPC.configPreviewTemplate, (_e, tpl: string, sample?: Record<string, unknown>) => {
    return renderTemplate(tpl, {
      platform: (sample?.platform as PlatformId) ?? 'bilibili',
      name: (sample?.name as string) ?? '示例主播',
      roomId: (sample?.roomId as string) ?? '5440',
      title: (sample?.title as string) ?? '示例标题',
      quality: (sample?.quality as string) ?? '原画'
    })
  })

  /* ============================================================= credential */

  ipcMain.handle(IPC.credentialGetAllStatus, () =>
    PLATFORMS.map((p) => {
      const rec = store.getCredentials()[p.id]
      return {
        platform: p.id,
        hasCookie: !!rec?.cookie,
        updatedAt: rec?.updatedAt,
        valid: rec?.valid,
        lastCheckedAt: rec?.lastCheckedAt,
        accountName: rec?.accountName,
        hint: rec?.hint
      }
    })
  )

  ipcMain.handle(IPC.credentialSet, (_e, platform: PlatformId, cookie: string, accountName?: string) => {
    store.setCredential(platform, cookie || '', accountName)
    return true
  })

  ipcMain.handle(IPC.credentialClear, (_e, platform: PlatformId) => {
    store.clearCredential(platform)
    return true
  })

  ipcMain.handle(IPC.credentialValidate, async (_e, platform: PlatformId) => {
    const cookie = store.getCookie(platform)
    if (!cookie) {
      store.patchCredential(platform, { valid: false, lastCheckedAt: Date.now(), hint: '未填写' })
      return { valid: false, hint: '未填写 Cookie' }
    }
    // 用平台自身的一个轻量接口验证 cookie 是否还有效
    try {
      const probe = PROBES[platform]
      const res = await fetch(probe.url, {
        headers: {
          'User-Agent': store.getConfig().userAgent,
          Cookie: cookie,
          Referer: DEFAULT_REFERER[platform] ?? ''
        },
        signal: AbortSignal.timeout(10_000)
      })
      const text = await res.text()
      const valid = probe.ok(text, res.status)
      const hint = valid ? probe.okHint : probe.badHint
      store.patchCredential(platform, { valid, lastCheckedAt: Date.now(), hint })
      return { valid, hint }
    } catch (e: any) {
      const hint = e?.message ?? String(e)
      store.patchCredential(platform, { valid: false, lastCheckedAt: Date.now(), hint })
      return { valid: false, hint }
    }
  })

  /* ================================================================ douyin */

  ipcMain.handle(IPC.streamerDouyinSearch, async (_e, keyword: string) => {
    try {
      return await searchDouyinUsers(keyword ?? '')
    } catch (e: any) {
      return { ok: false, users: [], error: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.douyinLoginOpen, () => openDouyinLogin())
  ipcMain.handle(IPC.douyinLoginImport, () => importDouyinCookie())

  ipcMain.handle(IPC.streamerDouyinFollowing, async (_e, maxPages?: number) => {
    try {
      return await fetchDouyinFollowing(typeof maxPages === 'number' ? maxPages : 10)
    } catch (e: any) {
      return { ok: false, users: [], error: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.streamerImportDouyinUsers, async (_e, users: DouyinSearchUser[], autoRecord?: boolean) => {
    try {
      return await streamers.importDouyinUsers(users ?? [], autoRecord)
    } catch (e: any) {
      return { added: 0, skipped: 0, failed: (users ?? []).length, errors: [e?.message ?? String(e)] }
    }
  })

  /**
   * 「解析即添加」：输入任意主播线索（抖音号 / 昵称 / 作品链接 / 主页链接 / 直播链接）
   * → 统一解析定位主播 → 直接入库监控。一步到位，省去先搜再点导入。
   */
  ipcMain.handle(
    IPC.streamerResolveAdd,
    async (
      _e,
      arg: { input: string; autoRecord?: boolean; danmakuEnabled?: boolean }
    ) => {
      const input = (arg?.input || '').trim()
      if (!input) return { ok: false, error: '请输入主播ID / 昵称 / 作品链接 / 主页链接' }
      try {
        const r = await searchDouyinUsers(input)
        if (!r.ok || !r.users?.length) {
          return { ok: false, needCookie: r.needCookie, error: r.error || '未能定位到主播', candidates: r.users ?? [] }
        }
        // 优先精确命中（抖音号完全一致），否则取第一个
        const kw = input.toLowerCase()
        const exact = r.users.find((u) => u.douyinId && u.douyinId.toLowerCase() === kw)
        const u = exact ?? r.users[0]
        const out = await streamers.add(
          {
            platform: 'douyin',
            input: u.roomUrl || u.liveUrl || u.homeUrl || '',
            secUid: u.secUid,
            homeUrl: u.homeUrl,
            liveUrl: u.liveUrl,
            douyinId: u.douyinId,
            avatar: u.avatar,
            name: u.nickname,
            autoRecord: arg?.autoRecord,
            danmakuEnabled: arg?.danmakuEnabled
          },
          false
        )
        return {
          ok: true,
          created: out.created,
          awaitingRoom: out.streamer?.awaitingRoom,
          name: out.streamer?.name,
          checkError: out.checkError,
          error: out.error,
          candidates: r.users
        }
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) }
      }
    }
  )

  /* ============================================================== streamer */

  ipcMain.handle(IPC.streamerGetAll, () => streamers.list())
  ipcMain.handle(IPC.streamerGetById, (_e, id: string) => streamers.getById(id))
  ipcMain.handle(IPC.streamerGetByTags, (_e, ids: string[]) => streamers.getByTags(ids ?? []))
  ipcMain.handle(IPC.streamerGetStats, () => streamers.stats())
  ipcMain.handle(IPC.streamerRefresh, () => streamers.list())

  ipcMain.handle(IPC.streamerAdd, async (_e, input: streamers.AddStreamerInput) => {
    const out = await streamers.add(input)
    if (out.error) throw new Error(out.error)
    // 顺便把探测失败原因带出来，渲染层据此提示用户（不再只在日志里）
    return { streamer: out.streamer, created: out.created, list: streamers.list(), checkError: out.streamer?.checkError }
  })

  ipcMain.handle(IPC.streamerBatchAdd, (_e, platform: PlatformId, text: string) =>
    streamers.batchAdd(platform, text)
  )

  ipcMain.handle(IPC.streamerUpdate, (_e, id: string, patch: Partial<Streamer>) =>
    streamers.update(id, patch)
  )

  ipcMain.handle(IPC.streamerDelete, (_e, id: string) => streamers.remove(id))
  ipcMain.handle(IPC.streamerToggleAutoRecord, (_e, id: string) => streamers.toggleAutoRecord(id))

  ipcMain.handle(IPC.streamerToggleTop, (_e, id: string) => {
    streamers.toggleTop(id)
    return streamers.list()
  })

  ipcMain.handle(IPC.streamerMoveUp, (_e, id: string) => streamers.move(id, 'up'))
  ipcMain.handle(IPC.streamerMoveDown, (_e, id: string) => streamers.move(id, 'down'))
  ipcMain.handle(IPC.streamerMoveToBottom, (_e, id: string) => streamers.move(id, 'bottom'))

  ipcMain.handle(IPC.streamerResetPosition, () => streamers.resetPosition())

  ipcMain.handle(IPC.streamerCheckExists, (_e, platform: PlatformId, input: string) =>
    streamers.checkExists(platform, input)
  )

  ipcMain.handle(IPC.streamerBatchCheckExists, (_e, platform: PlatformId, inputs: string[]) =>
    (inputs ?? []).map((i) => ({ input: i, ...streamers.checkExists(platform, i) }))
  )

  ipcMain.handle(IPC.streamerExportData, async () => {
    const res = await dialog.showSaveDialog({
      title: '导出主播库',
      defaultPath: `live-review-streamers-${Date.now()}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false }
    fs.writeFileSync(res.filePath, JSON.stringify(streamers.exportData(), null, 2), 'utf8')
    return { ok: true, file: res.filePath }
  })

  ipcMain.handle(IPC.streamerImportData, async () => {
    const res = await dialog.showOpenDialog({
      title: '导入主播库',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePaths[0]) return { ok: false }
    try {
      const data = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'))
      const out = streamers.importData(data)
      return { ok: !out.error, ...out }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.streamerOpenSaveDirectory, async (_e, id: string) => {
    const s = streamers.getById(id)
    const dir = s?.saveDir || store.getConfig().outputDir
    if (!dir) return false
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
    return true
  })

  ipcMain.handle(IPC.streamerInitMonitor, () => {
    monitor.initFromStreamers()
    return monitor.getTasks()
  })

  /* ================================================================== tags */

  ipcMain.handle(IPC.tagsGet, () => store.getTags())

  ipcMain.handle(IPC.tagsAdd, (_e, name: string, color?: string) => {
    const list = store.getTags()
    const trimmed = (name || '').trim()
    if (!trimmed) throw new Error('标签名不能为空')
    const exist = list.find((t) => t.name === trimmed)
    if (exist) return list
    list.push({
      id: `tag-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      name: trimmed,
      color: color || store.pickTagColor(),
      createdAt: Date.now()
    })
    store.setTags(list)
    push(EVT.streamerChanged, streamers.list())
    return list
  })

  ipcMain.handle(IPC.tagsAddBatch, (_e, names: string[]) => {
    const list = store.getTags()
    for (const n of names ?? []) {
      const trimmed = (n || '').trim()
      if (!trimmed || list.some((t) => t.name === trimmed)) continue
      list.push({
        id: `tag-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
        name: trimmed,
        color: store.pickTagColor(),
        createdAt: Date.now()
      })
    }
    store.setTags(list)
    return list
  })

  ipcMain.handle(IPC.tagsUpdate, (_e, id: string, patch: { name?: string; color?: string }) => {
    const list = store.getTags()
    const i = list.findIndex((t) => t.id === id)
    if (i >= 0) {
      list[i] = { ...list[i], ...patch }
      store.setTags(list)
    }
    return list
  })

  ipcMain.handle(IPC.tagsDelete, (_e, id: string) => {
    store.setTags(store.getTags().filter((t) => t.id !== id))
    // 同步从主播身上摘掉
    const list = streamers.list()
    let changed = false
    for (const s of list) {
      if (s.tags.includes(id)) {
        s.tags = s.tags.filter((t) => t !== id)
        changed = true
      }
    }
    if (changed) store.setStreamers(list)
    push(EVT.streamerChanged, streamers.list())
    return store.getTags()
  })

  /* ================================================================== link */

  ipcMain.handle(IPC.linkParse, async (_e, input: string, platform?: PlatformId) => {
    const raw = (input || '').trim()
    if (!raw) return { input: raw, ok: false, error: '请输入链接或房间号' }
    const candidates = platform ? [platform] : PLATFORMS.map((p) => p.id)
    for (const pid of candidates) {
      const roomId = streamers.parseInput(pid, raw)
      if (!roomId) continue
      try {
        const info = await getProvider(pid).getRoomInfo(roomId, {
          ua: store.getConfig().userAgent,
          cookie: store.getCookie(pid)
        })
        return { input: raw, ok: true, platform: pid, roomId, url: raw, streamer: info }
      } catch (e: any) {
        return { input: raw, ok: false, platform: pid, roomId, error: e?.message ?? String(e) }
      }
    }
    return { input: raw, ok: false, error: '无法识别平台或房间号' }
  })

  ipcMain.handle(IPC.linkBatchParse, async (_e, text: string, platform?: PlatformId) => {
    const lines = [...new Set((text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean))]
    const out: unknown[] = []
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      let hit: any = { input: raw, ok: false, error: '无法识别平台或房间号' }
      for (const pid of platform ? [platform] : PLATFORMS.map((p) => p.id)) {
        const roomId = streamers.parseInput(pid, raw)
        if (!roomId) continue
        hit = { input: raw, ok: true, platform: pid, roomId, url: raw }
        break
      }
      out.push(hit)
      push(EVT.importProgress, { kind: 'check', total: lines.length, done: i + 1, current: raw })
    }
    push(EVT.importComplete, { total: lines.length, done: lines.length })
    return out
  })

  /* =============================================================== monitor */

  ipcMain.handle(IPC.monitorGetAllTasks, () => monitor.getTasks())
  ipcMain.handle(IPC.monitorGetStats, () => monitor.stats())
  ipcMain.handle(IPC.monitorGetStatus, () => ({
    running: monitor.isRunning(),
    stats: monitor.stats()
  }))

  ipcMain.handle(IPC.monitorStart, () => {
    monitor.start()
    return monitor.stats()
  })

  ipcMain.handle(IPC.monitorStop, () => {
    monitor.stop()
    return monitor.stats()
  })

  ipcMain.handle(IPC.monitorResumeTaskMonitoring, (_e, ids?: string[]) => {
    monitor.resumeTaskMonitoring(ids)
    return monitor.getTasks()
  })

  ipcMain.handle(IPC.monitorAddTask, (_e, id: string) => {
    const s = streamers.getById(id)
    if (!s) throw new Error('主播不存在')
    monitor.addTask(s)
    return monitor.getTasks()
  })

  ipcMain.handle(IPC.monitorRemoveTask, (_e, id: string) => {
    monitor.removeTask(id)
    return monitor.getTasks()
  })

  /** 手动触发单个主播的探测（界面上的「检测」按钮） */
  ipcMain.handle(IPC.monitorCheckOne, async (_e, id: string) => {
    const status = await monitor.checkOne(id)
    const s = streamers.getById(id)
    return { streamerId: id, status, error: s?.checkError }
  })

  /* ================================================================ record */

  ipcMain.handle(IPC.recordManualStart, async (_e, id: string, quality?: string) => {
    const st = await recorder.startRecord(id, { manual: true, quality })
    return st
  })

  ipcMain.handle(IPC.recordManualStop, async (_e, id: string) => {
    await recorder.stopRecord(id, 'user')
    return true
  })

  ipcMain.handle(IPC.recordStopAll, () => {
    recorder.stopAll()
    return true
  })

  ipcMain.handle(IPC.recordIsRecording, (_e, id: string) => recorder.isRecording(id))
  ipcMain.handle(IPC.recordGetAllActive, () => recorder.listActive())
  ipcMain.handle(IPC.recordGetStats, () => recorder.recordStats())

  /* =============================================================== preview */

  ipcMain.handle(IPC.previewRoomInfo, async (_e, platform: PlatformId, input: string) => {
    const roomId = streamers.parseInput(platform, input)
    if (!roomId) throw new Error('无法识别房间号或链接')
    const info = await getProvider(platform).getRoomInfo(roomId, {
      ua: store.getConfig().userAgent,
      cookie: store.getCookie(platform)
    })
    return { roomId, info }
  })

  ipcMain.handle(IPC.previewStreams, async (_e, platform: PlatformId, roomId: string) => {
    const variants = await getProvider(platform).getStreams(roomId, {
      ua: store.getConfig().userAgent,
      cookie: store.getCookie(platform)
    })
    return variants
  })

  /** 返回经中继包装后的播放地址（渲染进程直接喂给 video） */
  ipcMain.handle(IPC.previewStart, async (_e, platform: PlatformId, roomId: string) => {
    const port = await startRelay()
    const referer = DEFAULT_REFERER[platform] ?? ''
    const cookie = store.getCookie(platform)
    const variants = await getProvider(platform).getStreams(roomId, {
      ua: store.getConfig().userAgent,
      cookie
    })
    if (!variants.length) throw new Error('没有可用的流地址（可能不在直播中）')
    const mapped = variants.map((v) => ({
      ...v,
      playUrl: proxied(v.url, referer, v.headers, cookie || undefined)
    }))
    // 转码输入优先用 FLV 清晰度（单 TCP 长连接，ffmpeg 边收边转边出，首帧远快于 HLS 分片流），
    // 没有 FLV 再退回 variants[0]。转码会把画面统一缩到 720p，输入清晰度不影响最终画质。
    const tcSrc = variants.find((v) => v.format === 'flv') ?? variants[0]
    return {
      port,
      referer,
      variants: mapped,
      // 浏览器不支持 HEVC 时的兜底：ffmpeg 实时转码成 H.264 FLV
      transcodeUrl: transcoded(tcSrc.url, referer, tcSrc.headers, cookie || undefined)
    }
  })

  ipcMain.handle(IPC.previewStopAll, () => {
    return { port: relayPort() }
  })

  /* =============================================================== danmaku */

  ipcMain.handle(IPC.danmakuGetStatus, (_e, id?: string) => {
    if (id) return danmakuHub.statusOf(id)
    return { list: danmakuHub.getStatuses(), active: danmakuHub.activeCount, total: danmakuHub.totalMessages }
  })

  ipcMain.handle(IPC.danmakuSetStreamerEnabled, (_e, id: string, enabled: boolean) => {
    streamers.update(id, { danmakuEnabled: !!enabled })
    streamers.syncDanmaku()
    return danmakuHub.statusOf(id)
  })

  ipcMain.handle(IPC.danmakuSubscribe, (_e, id: string) => {
    const s = streamers.getById(id)
    if (!s) throw new Error('主播不存在')
    danmakuHub.subscribe(s.id, s.platform, s.roomId)
    return danmakuHub.statusOf(id)
  })

  ipcMain.handle(IPC.danmakuUnsubscribe, (_e, id: string) => {
    danmakuHub.unsubscribe(id)
    return danmakuHub.statusOf(id)
  })

  /* =============================================================== history */

  ipcMain.handle(IPC.historyGetAll, () => store.getHistory())

  ipcMain.handle(IPC.historyDelete, (_e, id: string) => {
    const list = store.getHistory().filter((h) => h.id !== id)
    store.setHistory(list)
    push(EVT.historyChanged, list)
    return list
  })

  ipcMain.handle(IPC.historyClear, () => {
    store.setHistory([])
    push(EVT.historyChanged, [])
    return []
  })

  ipcMain.handle(IPC.historyOpenDirectory, async (_e, dir: string) => {
    if (!dir || !fs.existsSync(dir)) return false
    await shell.openPath(dir)
    return true
  })

  /* =============================================================== library */

  ipcMain.handle(IPC.libraryScan, (_e, opts?: library.ScanOptions) => {
    const cfg = store.getConfig()
    const files = library.scan({ ...(opts ?? {}), dir: opts?.dir || cfg.outputDir })
    return { files, summary: library.summary(files) }
  })

  ipcMain.handle(IPC.libraryDeleteFile, async (_e, paths: string[], withCompanions = true) => {
    const out = await library.removeFiles(paths ?? [], withCompanions)
    push(EVT.sourceDeleted, paths)
    return out
  })

  ipcMain.handle(IPC.libraryOpenFile, async (_e, p: string) => library.openFile(p))
  ipcMain.handle(IPC.libraryOpenDirectory, async (_e, dir: string) => library.openDirectory(dir))

  /* ============================================================ transcribe */

  ipcMain.handle(IPC.transcribeCheckLocalEnvironment, () => transcribe.checkEnvironment())
  ipcMain.handle(IPC.transcribeGetSettings, () => transcribe.getSettings())

  ipcMain.handle(IPC.transcribeSaveSettings, (_e, patch: Partial<TranscribeSettings>) =>
    transcribe.saveSettings(patch ?? {})
  )

  ipcMain.handle(IPC.transcribeScanRecordDirectory, async (_e, dir?: string) => {
    const root = dir || store.getConfig().outputDir
    return transcribe.scanFiles(root, true)
  })

  ipcMain.handle(IPC.transcribeSelectFiles, async () => {
    const res = await dialog.showOpenDialog({
      title: '选择要转写的视频',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '视频', extensions: ['mp4', 'ts', 'mkv', 'flv', 'mov', 'm4v'] }]
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle(IPC.transcribeSelectFolder, async () => {
    const res = await dialog.showOpenDialog({ title: '选择目录', properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC.transcribeSelectLocalModelRoot, async () => {
    const res = await dialog.showOpenDialog({ title: '选择模型根目录', properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC.transcribeInstallLocalDependencies, () => {
    transcribe.installDependencies()
    return true
  })

  ipcMain.handle(IPC.transcribeDownloadLocalModels, () => {
    transcribe.downloadModels()
    return true
  })

  ipcMain.handle(IPC.transcribeStartBatch, async (_e, files: transcribe.TranscribeItem[] | string[]) => {
    const items = (files ?? []).map((f) =>
      typeof f === 'string' ? { file: f, name: path.basename(f), sizeBytes: 0 } : f
    ) as transcribe.TranscribeItem[]
    return transcribe.startBatch(items)
  })

  ipcMain.handle(IPC.transcribeStop, () => {
    transcribe.stop()
    return true
  })

  ipcMain.handle(IPC.transcribeDeleteFiles, (_e, file: string) => transcribe.deleteOutputs(file))
  ipcMain.handle(IPC.transcribeJobs, () => store.getJobs('transcribe'))

  /* =============================================================== merger */

  ipcMain.handle(IPC.mergerScanRecordDirectory, (_e, dir?: string) => {
    const root = dir || store.getConfig().outputDir
    return merger.scanGroups(root, true)
  })

  ipcMain.handle(IPC.mergerSelectFolder, async () => {
    const res = await dialog.showOpenDialog({ title: '选择目录', properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(
    IPC.mergerStartBatchMerge,
    async (_e, groups: merger.MergeGroup[], opts?: merger.MergeOptions) =>
      merger.startBatchMerge(groups ?? [], opts ?? {})
  )

  ipcMain.handle(IPC.mergerStop, () => true)
  ipcMain.handle(IPC.mergerGetAutoTasks, () => merger.getAutoTasks())
  ipcMain.handle(IPC.mergerClearAutoTasks, () => {
    merger.clearAutoTasks()
    return []
  })

  /* ============================================================ converter */

  ipcMain.handle(IPC.converterScanRecordDirectory, async (_e, dir?: string) => {
    const root = dir || store.getConfig().outputDir
    return converter.scanFiles(root, true)
  })

  ipcMain.handle(IPC.converterSelectFolder, async () => {
    const res = await dialog.showOpenDialog({ title: '选择目录', properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC.converterStartBatchConvert, async (_e, items: converter.ConvertItem[], opts: converter.ConvertOptions) =>
    converter.startBatchConvert(items ?? [], opts)
  )

  /* ================================================================ hudi */

  ipcMain.handle(IPC.hudiGetStatus, () => capture.status())

  ipcMain.handle(IPC.hudiListSources, () => capture.listSources(true))
  ipcMain.handle(IPC.hudiListAudioDevices, () => capture.audioDevices())

  ipcMain.handle(IPC.hudiSetConfig, (_e, patch: Partial<CaptureConfig>) => capture.setCaptureConfig(patch ?? {}))

  ipcMain.handle(IPC.hudiStartRecord, (_e, override?: Partial<CaptureConfig>) => {
    const r = capture.startCapture(override)
    if (!r.ok) throw new Error(r.error || '启动捕获失败')
    return r
  })

  ipcMain.handle(IPC.hudiStopRecord, () => {
    capture.stopCapture()
    return true
  })

  /* ================================================================ disk */

  ipcMain.handle(IPC.diskGetUsage, (_e, target?: string) => disk.getUsage(target))
  ipcMain.handle(IPC.diskGetMonitorStatus, () => disk.status())

  ipcMain.handle(IPC.diskRestartMonitor, () => disk.restart())

  ipcMain.handle(IPC.diskRunCheck, async () => {
    const usage = await disk.check()
    return { usage, status: disk.status() }
  })

  /* ================================================================ log */

  /** 读取当天日志文件尾部（供界面「运行日志」页展示） */
  ipcMain.handle(IPC.logTail, (_e, maxLines?: number) => {
    const dir = getLogDir()
    const n = Math.max(50, Math.min(5000, Number(maxLines) || 500))
    let file = ''
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => /^app-.*\.log$/.test(f))
        .sort()
      if (files.length) file = path.join(dir, files[files.length - 1])
    } catch {
      /* ignore */
    }
    if (!file || !fs.existsSync(file)) return { file: '', lines: [] as string[] }
    try {
      const txt = fs.readFileSync(file, 'utf8')
      return { file, lines: txt.split(/\r?\n/).filter(Boolean).slice(-n) }
    } catch (e: any) {
      return { file, lines: [`读取日志失败：${e?.message ?? e}`] }
    }
  })

  /** 渲染进程把前端错误写进同一个日志文件（便于排查预览/播放器问题） */
  ipcMain.handle(IPC.logWrite, (_e, level: string, msg: string) => {
    const lvl = (['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info') as
      | 'debug'
      | 'info'
      | 'warn'
      | 'error'
    log('renderer')[lvl](String(msg ?? ''))
    return true
  })

  /* ============================================================== notify */

  ipcMain.handle(IPC.notifyTest, async () => {
    const results = await notify('test', {
      name: '测试主播',
      platform: 'bilibili',
      platformName: '哔哩哔哩',
      title: '这是一条测试通知',
      roomId: '5440',
      message: '如果你收到这条消息，说明通知通道配置正确。'
    })
    if (!results.length) return { ok: false, error: '没有启用任何通知通道' }
    const failed = results.filter((r) => !r.ok)
    return {
      ok: failed.length === 0,
      channels: results,
      error: failed.length ? failed.map((f) => `${f.channel}: ${f.error}`).join('；') : undefined
    }
  })

  /* =============================================================== theme */

  ipcMain.handle(IPC.themeGet, () => {
    const cfg = store.getConfig()
    return {
      theme: cfg.theme,
      effective: cfg.theme === 'system' ? (nativeThemeDark() ? 'dark' : 'light') : cfg.theme
    }
  })

  ipcMain.handle(IPC.themeSet, (_e, theme: 'light' | 'dark' | 'system') => {
    store.setConfig({ theme })
    push(EVT.themeChanged, { theme })
    push(EVT.configChanged, store.getConfig())
    return { theme }
  })

  /* ============================================================== system */

  ipcMain.handle(IPC.systemGetInfo, (): SystemInfo => {
    const cfg = store.getConfig()
    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      portable: !!store.portableDataRoot(),
      dataDir: store.dataDir(),
      userData: app.getPath('userData'),
      logDir: getLogDir(),
      outputDir: cfg.outputDir,
      ffmpeg: detectFfmpeg()
    }
  })

  ipcMain.handle('meta:enums', () => ({
    platforms: listPlatforms(),
    platformMeta: PLATFORMS,
    captureSources: CAPTURE_SOURCES,
    qualities: QUALITY_PRESETS,
    referers: DEFAULT_REFERER,
    relayPort: relayPort()
  }))

  ipcMain.handle(IPC.systemOpenDevTools, (e) => {
    windowOf(e)?.webContents.openDevTools({ mode: 'detach' })
    return true
  })

  /* ================================================================= 联动 */

  // 配置变更后：重排监控间隔 / 重启磁盘看护 / 对齐弹幕订阅
  function afterConfigChange(patch: Partial<AppConfig>): void {
    if (patch.checkIntervalSec != null && monitor.isRunning()) monitor.resumeTaskMonitoring()
    if (patch.disk) disk.restart()
    if (patch.capture) capture.setCaptureConfig(patch.capture)
    emitConfig()
    push(EVT.themeChanged, { theme: patch.theme ?? store.getConfig().theme })
  }

  function emitConfig(): void {
    push(EVT.configChanged, store.getConfig())
  }

  // 主播库
  streamers.streamers.on('changed', (list: Streamer[]) => push(EVT.streamerChanged, list))
  streamers.streamers.on('stats', (s) => push(EVT.streamerStatus, s))
  streamers.streamers.on('import-progress', (p) => push(EVT.importProgress, p))
  streamers.streamers.on('import-complete', (r) => push(EVT.importComplete, r))

  // 监控
  monitor.monitor.on('started', () => push(EVT.monitorStarted))
  monitor.monitor.on('stopped', () => push(EVT.monitorStopped))
  monitor.monitor.on('status', (s) => push(EVT.monitorStatus, s))
  monitor.monitor.on('checked', (id: string, status: string, error?: string) =>
    push(EVT.taskChecked, { streamerId: id, status, error })
  )
  monitor.monitor.on('stream-change', (id: string, next: string, prev: string) =>
    push(EVT.taskStreamChange, { streamerId: id, next, prev })
  )
  monitor.monitor.on('persisted', () => push(EVT.streamerChanged, streamers.list()))

  // 开播 → 自动录制 + 通知
  monitor.monitor.on('live-start', async (id: string) => {
    const s = streamers.getById(id)
    if (!s) return
    const cfg = store.getConfig()
    void notify('live-start', {
      name: s.name,
      platform: s.platform,
      platformName: platformName(s.platform),
      title: s.roomTitle,
      roomId: s.roomId
    })
    if (!s.autoRecord) {
      L.info('开播，但主播未勾自动录制，跳过', { streamerId: id, name: s.name })
      return
    }
    if (!cfg.autoRecord) {
      L.info('开播，主播已勾自动录制但全局开关未开，跳过', { streamerId: id, name: s.name })
      return
    }
    try {
      await recorder.startRecord(id, { manual: false })
    } catch (e: any) {
      L.warn('自动录制启动失败', { streamerId: id, name: s.name, msg: e?.message ?? e })
    }
  })

  monitor.monitor.on('live-end', async (id: string) => {
    if (recorder.isRecording(id)) await recorder.stopRecord(id, 'stream-end')
  })

  // 录制
  recorder.recorder.on('update', (st) => push(EVT.recordStatus, st))
  recorder.recorder.on('started', (st) => {
    push(EVT.recordingStarted, st)
    void notify('record-start', {
      name: st.streamerName,
      platform: st.platform,
      platformName: platformName(st.platform),
      title: st.title,
      roomId: st.roomId
    })
  })
  recorder.recorder.on('ended', (st, items) => {
    push(EVT.recordingEnded, st)
    push(EVT.historyChanged, store.getHistory())
    void notify('record-end', {
      name: st.streamerName,
      platform: st.platform,
      platformName: platformName(st.platform),
      title: st.title,
      file: st.segments[0],
      durationText: `${Math.round(st.durationMs / 1000)}s`,
      sizeText: `${(st.sizeBytes / 1024 ** 2).toFixed(1)} MB`,
      message: items?.length ? `产出 ${items.length} 个文件` : undefined
    })
    // 自动合并 / 自动转写
    const cfg = store.getConfig()
    if (st.segments.length > 1 && cfg.autoMerge) {
      merger.queueAutoTask(path.dirname(st.segments[0]), st.segments)
    }
    if (cfg.autoTranscribe) {
      void transcribe
        .startBatch(st.segments.map((f: string) => ({ file: f, name: path.basename(f), sizeBytes: 0 })))
        .catch(() => void 0)
    }
  })
  recorder.recorder.on('error', (st) => {
    push(EVT.recordingError, st)
    void notify('error', {
      name: st.streamerName,
      platform: st.platform,
      platformName: platformName(st.platform),
      message: st.error
    })
  })

  // 弹幕
  danmakuHub.on('message', (streamerId: string, m: unknown) => push(EVT.danmakuMessage, { streamerId, message: m }))
  danmakuHub.on('status', (s) => push(EVT.danmakuStatus, s))

  // 合并 / 转码
  merger.merger.on('progress', (j) => push(EVT.mergeProgress, j))
  merger.merger.on('batch-progress', (p) => push(EVT.mergeProgress, p))
  merger.merger.on('completed', (f: string) => push(EVT.mergeCompleted, f))
  merger.merger.on('auto-tasks', (t) => push(EVT.mergeProgress, t))
  converter.converter.on('progress', (j) => push(EVT.convertProgress, j))
  converter.converter.on('batch-progress', (p) => push(EVT.convertProgress, p))

  // 转写
  transcribe.transcribe.on('progress', (p) => push(EVT.transcribeProgress, p))
  transcribe.transcribe.on('batch-progress', (p) => push(EVT.transcribeProgress, p))
  transcribe.transcribe.on('local-install', (p) => push(EVT.transcribeLocalInstall, p))

  // 磁盘
  disk.disk.on('status', (s) => push(EVT.diskInfo, s))
  disk.disk.on('usage', (u) => push(EVT.diskInfo, u))
  disk.disk.on('warning', (u) => {
    push(EVT.diskWarning, u)
    void notify('disk-warning', {
      message: `剩余空间仅 ${(u.freeBytes / 1024 ** 3).toFixed(1)}GB（${u.path}）`
    })
  })

  // 视频号捕获
  capture.capture.on('status', (s) => push(EVT.hudiStatus, s))
  capture.capture.on('started', (f: string) => push(EVT.hudiSources, { event: 'started', file: f }))
  capture.capture.on('ended', (p) => push(EVT.hudiSources, { event: 'ended', ...p }))
  capture.capture.on('error', (m: string) => push(EVT.systemError, m))
}

function platformName(id: PlatformId): string {
  return PLATFORMS.find((p) => p.id === id)?.name ?? id
}

/** 系统主题是否深色 */
function nativeThemeDark(): boolean {
  return !!nativeTheme?.shouldUseDarkColors
}

/** 凭证校验探针：各平台一个轻量接口，判断 cookie 是否还活着 */
const PROBES: Record<PlatformId, { url: string; ok: (text: string, status: number) => boolean; okHint: string; badHint: string }> = {
  bilibili: {
    url: 'https://api.bilibili.com/x/web-interface/nav',
    ok: (t) => {
      try {
        return JSON.parse(t)?.data?.isLogin === true
      } catch {
        return false
      }
    },
    okHint: 'Cookie 有效（已登录）',
    badHint: 'Cookie 失效或未登录'
  },
  douyu: {
    url: 'https://www.douyu.com/member/getUserInfo',
    ok: (t, s) => s === 200 && /"nickName"|"uid"/.test(t),
    okHint: 'Cookie 有效',
    badHint: 'Cookie 无效'
  },
  huya: {
    url: 'https://www.huya.com/',
    ok: (_t, s) => s === 200,
    okHint: '请求可达（虎牙无需登录）',
    badHint: '请求失败'
  },
  douyin: {
    url: 'https://live.douyin.com/',
    ok: (_t, s) => s === 200,
    okHint: 'Cookie 已保存',
    badHint: '请求失败'
  },
  kuaishou: {
    url: 'https://live.kuaishou.com/',
    ok: (_t, s) => s === 200,
    okHint: 'Cookie 已保存',
    badHint: '请求失败'
  }
}
