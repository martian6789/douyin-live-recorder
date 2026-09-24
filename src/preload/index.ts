/**
 * preload：主进程与界面之间唯一的桥。
 *
 * 原则：
 * - 只暴露「动作」与「事件订阅」，不暴露 ipcRenderer 本身；
 * - 通道名全部来自 shared/ipc.ts，渲染进程不写裸字符串；
 * - 事件订阅一律返回「取消订阅」函数，组件卸载时调用，避免重复监听。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { EVT, IPC } from '../shared/ipc'
import type { Api } from '../shared/api'
import type {
  AddResult,
  AppConfig,
  CaptureConfig,
  CaptureSource,
  CaptureStatus,
  CredentialState,
  DiskMonitorStatus,
  DiskUsage,
  DouyinSearchResult,
  DouyinSearchUser,
  HistoryItem,
  ImportUsersResult,
  MonitorStats,
  MonitorTask,
  ParsedLink,
  PlatformId,
  RecordFile,
  RecordStats,
  RecordTaskState,
  Streamer,
  StreamerStats,
  StreamVariant,
  SystemInfo,
  Tag,
  TemplateVariable,
  TranscribeEnvironment,
  TranscribeSettings,
  UpdateCheckResult,
  RunningJob
} from '../shared/types'

type Unsub = () => void

function on<T>(channel: string, cb: (payload: T) => void): Unsub {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const invoke = <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

/**
 * 实现必须满足 shared/api.ts 里的 Api 契约：少一个方法、签名对不上都会在编译期报错。
 */
const api: Api = {
  /* ------------------------------------------------------------------ app */
  app: {
    info: () => invoke<{ version: string; name: string; isPackaged: boolean }>(IPC.appGetInfo),
    getAutoStartup: () => invoke<boolean>(IPC.appGetAutoStartup),
    setAutoStartup: (v: boolean) => invoke<boolean>(IPC.appSetAutoStartup, v),
    checkUpdate: () => invoke<UpdateCheckResult>(IPC.appCheckVersionUpdate),
    checkFirstRun: () => invoke<boolean>(IPC.appCheckFirstRun),
    setFirstRunCompleted: () => invoke<boolean>(IPC.appSetFirstRunCompleted),
    openExternal: (url: string) => invoke<boolean>(IPC.appOpenExternal, url),
    openLogDirectory: () => invoke<string>(IPC.appOpenLogDirectory),
    showInFolder: (p: string) => invoke<boolean>(IPC.appShowInFolder, p),
    quit: () => invoke<void>(IPC.appQuit)
  },

  /* --------------------------------------------------------------- window */
  win: {
    minimize: (behavior?: 'taskbar' | 'tray') => invoke<void>(IPC.windowMinimize, behavior),
    toggleMaximize: () => invoke<boolean>(IPC.windowToggleMaximize),
    close: () => invoke<void>(IPC.windowClose),
    isMaximized: () => invoke<boolean>(IPC.windowIsMaximized)
  },

  /* --------------------------------------------------------------- config */
  config: {
    get: () => invoke<AppConfig>(IPC.configGet),
    set: (patch: Partial<AppConfig>) => invoke<AppConfig>(IPC.configSet, patch),
    setMultiple: (patch: Partial<AppConfig>) => invoke<AppConfig>(IPC.configSetMultiple, patch),
    reset: () => invoke<AppConfig>(IPC.configReset),
    selectDirectory: (title?: string) => invoke<string | null>(IPC.configSelectDirectory, title),
    openSaveDirectory: () => invoke<boolean>(IPC.configOpenSaveDirectory),
    templateVariables: () => invoke<TemplateVariable[]>(IPC.configGetTemplateVariables),
    validateTemplate: (tpl: string) =>
      invoke<{ ok: boolean; unknown: string[]; normalized: string; error?: string }>(
        IPC.configValidateTemplate,
        tpl
      ),
    previewTemplate: (tpl: string, sample?: Record<string, unknown>) =>
      invoke<string>(IPC.configPreviewTemplate, tpl, sample)
  },

  /* ----------------------------------------------------------- credential */
  credential: {
    all: () => invoke<CredentialState[]>(IPC.credentialGetAllStatus),
    set: (platform: PlatformId, cookie: string, accountName?: string) =>
      invoke<boolean>(IPC.credentialSet, platform, cookie, accountName),
    clear: (platform: PlatformId) => invoke<boolean>(IPC.credentialClear, platform),
    validate: (platform: PlatformId) =>
      invoke<{ valid: boolean; hint?: string }>(IPC.credentialValidate, platform),
    douyinLoginOpen: () => invoke<boolean>(IPC.douyinLoginOpen),
    douyinLoginImport: () =>
      invoke<{ ok: boolean; length?: number; error?: string }>(IPC.douyinLoginImport)
  },

  /* ------------------------------------------------------------- streamer */
  streamer: {
    list: () => invoke<Streamer[]>(IPC.streamerGetAll),
    get: (id: string) => invoke<Streamer | null>(IPC.streamerGetById, id),
    byTags: (tagIds: string[]) => invoke<Streamer[]>(IPC.streamerGetByTags, tagIds),
    stats: () => invoke<StreamerStats>(IPC.streamerGetStats),
    refresh: () => invoke<Streamer[]>(IPC.streamerRefresh),
    add: (input: {
      platform: PlatformId
      input: string
      name?: string
      remark?: string
      tags?: string[]
      autoRecord?: boolean
      quality?: string
      saveDir?: string
      danmakuEnabled?: boolean
    }) => invoke<{ streamer?: Streamer; created: boolean; list: Streamer[]; checkError?: string }>(IPC.streamerAdd, input),
    batchAdd: (platform: PlatformId, text: string) =>
      invoke<AddResult>(IPC.streamerBatchAdd, platform, text),
    searchDouyin: (keyword: string) => invoke<DouyinSearchResult>(IPC.streamerDouyinSearch, keyword),
    douyinFollowing: (maxPages?: number) =>
      invoke<DouyinSearchResult>(IPC.streamerDouyinFollowing, maxPages),
    importDouyinUsers: (users: DouyinSearchUser[], autoRecord?: boolean) =>
      invoke<ImportUsersResult>(IPC.streamerImportDouyinUsers, users, autoRecord),
    resolveAdd: (arg: { input: string; autoRecord?: boolean; danmakuEnabled?: boolean }) =>
      invoke<any>(IPC.streamerResolveAdd, arg),
    update: (id: string, patch: Partial<Streamer>) => invoke<Streamer[]>(IPC.streamerUpdate, id, patch),
    remove: (id: string) => invoke<Streamer[]>(IPC.streamerDelete, id),
    toggleAutoRecord: (id: string) => invoke<boolean>(IPC.streamerToggleAutoRecord, id),
    toggleTop: (id: string) => invoke<Streamer[]>(IPC.streamerToggleTop, id),
    moveUp: (id: string) => invoke<Streamer[]>(IPC.streamerMoveUp, id),
    moveDown: (id: string) => invoke<Streamer[]>(IPC.streamerMoveDown, id),
    moveToBottom: (id: string) => invoke<Streamer[]>(IPC.streamerMoveToBottom, id),
    resetPosition: () => invoke<Streamer[]>(IPC.streamerResetPosition),
    checkExists: (platform: PlatformId, input: string) =>
      invoke<{ exists: boolean; streamer?: Streamer; roomId?: string | null }>(
        IPC.streamerCheckExists,
        platform,
        input
      ),
    batchCheckExists: (platform: PlatformId, inputs: string[]) =>
      invoke<{ input: string; exists: boolean; streamer?: Streamer }[]>(
        IPC.streamerBatchCheckExists,
        platform,
        inputs
      ),
    exportData: () => invoke<{ ok: boolean; file?: string }>(IPC.streamerExportData),
    importData: () =>
      invoke<{ ok: boolean; added?: number; skipped?: number; error?: string }>(IPC.streamerImportData),
    openSaveDirectory: (id: string) => invoke<boolean>(IPC.streamerOpenSaveDirectory, id),
    initMonitor: () => invoke<MonitorTask[]>(IPC.streamerInitMonitor)
  },

  /* ----------------------------------------------------------------- tags */
  tags: {
    list: () => invoke<Tag[]>(IPC.tagsGet),
    add: (name: string, color?: string) => invoke<Tag[]>(IPC.tagsAdd, name, color),
    addBatch: (names: string[]) => invoke<Tag[]>(IPC.tagsAddBatch, names),
    update: (id: string, patch: { name?: string; color?: string }) =>
      invoke<Tag[]>(IPC.tagsUpdate, id, patch),
    remove: (id: string) => invoke<Tag[]>(IPC.tagsDelete, id)
  },

  /* ----------------------------------------------------------------- link */
  link: {
    parse: (input: string, platform?: PlatformId) =>
      invoke<ParsedLink>(IPC.linkParse, input, platform),
    batchParse: (text: string, platform?: PlatformId) =>
      invoke<ParsedLink[]>(IPC.linkBatchParse, text, platform)
  },

  /* -------------------------------------------------------------- monitor */
  monitor: {
    tasks: () => invoke<MonitorTask[]>(IPC.monitorGetAllTasks),
    stats: () => invoke<MonitorStats>(IPC.monitorGetStats),
    status: () => invoke<{ running: boolean; stats: MonitorStats }>(IPC.monitorGetStatus),
    start: () => invoke<MonitorStats>(IPC.monitorStart),
    stop: () => invoke<MonitorStats>(IPC.monitorStop),
    resume: (ids?: string[]) => invoke<MonitorTask[]>(IPC.monitorResumeTaskMonitoring, ids),
    addTask: (id: string) => invoke<MonitorTask[]>(IPC.monitorAddTask, id),
    removeTask: (id: string) => invoke<MonitorTask[]>(IPC.monitorRemoveTask, id),
    checkOne: (id: string) =>
      invoke<{ streamerId: string; status: string; error?: string }>(IPC.monitorCheckOne, id)
  },

  /* --------------------------------------------------------------- record */
  record: {
    start: (id: string, quality?: string) => invoke<RecordTaskState>(IPC.recordManualStart, id, quality),
    stop: (id: string) => invoke<boolean>(IPC.recordManualStop, id),
    stopAll: () => invoke<boolean>(IPC.recordStopAll),
    isRecording: (id: string) => invoke<boolean>(IPC.recordIsRecording, id),
    active: () => invoke<RecordTaskState[]>(IPC.recordGetAllActive),
    stats: () => invoke<RecordStats>(IPC.recordGetStats)
  },

  /* -------------------------------------------------------------- preview */
  preview: {
    roomInfo: (platform: PlatformId, input: string) =>
      invoke<{ roomId: string; info: Record<string, unknown> }>(IPC.previewRoomInfo, platform, input),
    streams: (platform: PlatformId, roomId: string) =>
      invoke<StreamVariant[]>(IPC.previewStreams, platform, roomId),
    start: (platform: PlatformId, roomId: string) =>
      invoke<{
        port: number
        referer: string
        variants: (StreamVariant & { playUrl: string })[]
        transcodeUrl?: string
      }>(IPC.previewStart, platform, roomId),
    stopAll: () => invoke<{ port: number }>(IPC.previewStopAll)
  },

  /* -------------------------------------------------------------- danmaku */
  danmaku: {
    status: (id?: string) => invoke<unknown>(IPC.danmakuGetStatus, id),
    setStreamerEnabled: (id: string, enabled: boolean) =>
      invoke<unknown>(IPC.danmakuSetStreamerEnabled, id, enabled),
    subscribe: (id: string) => invoke<unknown>(IPC.danmakuSubscribe, id),
    unsubscribe: (id: string) => invoke<unknown>(IPC.danmakuUnsubscribe, id)
  },

  /* -------------------------------------------------------------- history */
  history: {
    list: () => invoke<HistoryItem[]>(IPC.historyGetAll),
    remove: (id: string) => invoke<HistoryItem[]>(IPC.historyDelete, id),
    clear: () => invoke<HistoryItem[]>(IPC.historyClear),
    openDirectory: (dir: string) => invoke<boolean>(IPC.historyOpenDirectory, dir)
  },

  /* -------------------------------------------------------------- library */
  library: {
    scan: (opts?: { dir?: string; recursive?: boolean; since?: number; keyword?: string }) =>
      invoke<{
        files: RecordFile[]
        summary: {
          count: number
          totalBytes: number
          todayCount: number
          todayBytes: number
          withDanmaku: number
          withSubtitle: number
        }
      }>(IPC.libraryScan, opts),
    removeFiles: (paths: string[], withCompanions = true) =>
      invoke<{ removed: number; failed: string[] }>(IPC.libraryDeleteFile, paths, withCompanions),
    openFile: (p: string) => invoke<boolean>(IPC.libraryOpenFile, p),
    openDirectory: (dir: string) => invoke<boolean>(IPC.libraryOpenDirectory, dir)
  },

  /* ----------------------------------------------------------- transcribe */
  transcribe: {
    checkEnv: () => invoke<TranscribeEnvironment>(IPC.transcribeCheckLocalEnvironment),
    getSettings: () => invoke<TranscribeSettings>(IPC.transcribeGetSettings),
    saveSettings: (patch: Partial<TranscribeSettings>) =>
      invoke<TranscribeSettings>(IPC.transcribeSaveSettings, patch),
    scan: (dir?: string) =>
      invoke<{ file: string; name: string; sizeBytes: number; hasSubtitle?: boolean }[]>(
        IPC.transcribeScanRecordDirectory,
        dir
      ),
    selectFiles: () => invoke<string[]>(IPC.transcribeSelectFiles),
    selectFolder: () => invoke<string | null>(IPC.transcribeSelectFolder),
    selectModelRoot: () => invoke<string | null>(IPC.transcribeSelectLocalModelRoot),
    installDeps: () => invoke<boolean>(IPC.transcribeInstallLocalDependencies),
    downloadModels: () => invoke<boolean>(IPC.transcribeDownloadLocalModels),
    startBatch: (files: (string | { file: string; name: string; sizeBytes: number })[]) =>
      invoke<RunningJob[]>(IPC.transcribeStartBatch, files),
    stop: () => invoke<boolean>(IPC.transcribeStop),
    deleteOutputs: (file: string) => invoke<string[]>(IPC.transcribeDeleteFiles, file),
    jobs: () => invoke<RunningJob[]>(IPC.transcribeJobs)
  },

  /* -------------------------------------------------------------- merger */
  merger: {
    scan: (dir?: string) =>
      invoke<{ output: string; files: string[]; dir: string; totalBytes: number; exists: boolean }[]>(
        IPC.mergerScanRecordDirectory,
        dir
      ),
    selectFolder: () => invoke<string | null>(IPC.mergerSelectFolder),
    startBatch: (
      groups: { output: string; files: string[]; dir: string; totalBytes: number; exists: boolean }[],
      opts?: { deleteSource?: boolean; overwrite?: boolean }
    ) => invoke<RunningJob[]>(IPC.mergerStartBatchMerge, groups, opts),
    autoTasks: () => invoke<unknown[]>(IPC.mergerGetAutoTasks),
    clearAutoTasks: () => invoke<unknown[]>(IPC.mergerClearAutoTasks)
  },

  /* ----------------------------------------------------------- converter */
  converter: {
    scan: (dir?: string) =>
      invoke<{ file: string; name: string; dir: string; sizeBytes: number }[]>(
        IPC.converterScanRecordDirectory,
        dir
      ),
    selectFolder: () => invoke<string | null>(IPC.converterSelectFolder),
    startBatch: (
      items: { file: string; name: string; dir: string; sizeBytes: number }[],
      opts: {
        container: 'mp4' | 'ts' | 'mkv' | 'flv'
        reencode?: boolean
        outDir?: string
        overwrite?: boolean
        deleteSource?: boolean
      }
    ) => invoke<RunningJob[]>(IPC.converterStartBatchConvert, items, opts)
  },

  /* ---------------------------------------------------------------- hudi */
  hudi: {
    status: () => invoke<CaptureStatus>(IPC.hudiGetStatus),
    sources: () => invoke<CaptureSource[]>(IPC.hudiListSources),
    audioDevices: () => invoke<string[]>(IPC.hudiListAudioDevices),
    setConfig: (patch: Partial<CaptureConfig>) => invoke<CaptureConfig>(IPC.hudiSetConfig, patch),
    start: (override?: Partial<CaptureConfig>) =>
      invoke<{ ok: boolean; file?: string }>(IPC.hudiStartRecord, override),
    stop: () => invoke<boolean>(IPC.hudiStopRecord)
  },

  /* ---------------------------------------------------------------- disk */
  disk: {
    usage: (target?: string) => invoke<DiskUsage>(IPC.diskGetUsage, target),
    status: () => invoke<DiskMonitorStatus>(IPC.diskGetMonitorStatus),
    restart: () => invoke<DiskMonitorStatus>(IPC.diskRestartMonitor),
    runCheck: () => invoke<{ usage: DiskUsage; status: DiskMonitorStatus }>(IPC.diskRunCheck)
  },

  /* ---------------------------------------------------------------- log */
  log: {
    tail: (maxLines?: number) => invoke<{ file: string; lines: string[] }>(IPC.logTail, maxLines),
    write: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) =>
      invoke<boolean>(IPC.logWrite, level, msg)
  },

  /* -------------------------------------------------------------- notify */
  notify: {
    test: () =>
      invoke<{ ok: boolean; channels?: { channel: string; ok: boolean; error?: string }[]; error?: string }>(
        IPC.notifyTest
      )
  },

  /* --------------------------------------------------------------- theme */
  theme: {
    get: () => invoke<{ theme: 'light' | 'dark' | 'system'; effective: 'light' | 'dark' }>(IPC.themeGet),
    set: (theme: 'light' | 'dark' | 'system') =>
      invoke<{ theme: string }>(IPC.themeSet, theme)
  },

  /* -------------------------------------------------------------- system */
  system: {
    info: () => invoke<SystemInfo>(IPC.systemGetInfo),
    openDevTools: () => invoke<boolean>(IPC.systemOpenDevTools),
    meta: () =>
      invoke<{
        platforms: { id: PlatformId; name: string; danmaku: boolean }[]
        platformMeta: { id: PlatformId; name: string; color: string; needsCookie: boolean; danmaku: boolean }[]
        captureSources: { id: string; name: string; color: string }[]
        qualities: readonly string[]
        referers: Record<string, string>
        relayPort: number
      }>('meta:enums')
  },

  /* -------------------------------------------------------------- events */
  on: {
    recordStatus: (cb: (s: RecordTaskState) => void) => on(EVT.recordStatus, cb),
    recordingStarted: (cb: (s: RecordTaskState) => void) => on(EVT.recordingStarted, cb),
    recordingEnded: (cb: (s: RecordTaskState) => void) => on(EVT.recordingEnded, cb),
    recordingError: (cb: (s: RecordTaskState) => void) => on(EVT.recordingError, cb),
    recordingStreamChange: (cb: (s: unknown) => void) => on(EVT.recordingStreamChange, cb),

    monitorStatus: (cb: (s: MonitorStats) => void) => on(EVT.monitorStatus, cb),
    monitorStarted: (cb: () => void) => on(EVT.monitorStarted, cb),
    monitorStopped: (cb: () => void) => on(EVT.monitorStopped, cb),
    taskChecked: (cb: (p: { streamerId: string; status: string; error?: string }) => void) =>
      on(EVT.taskChecked, cb),
    taskCheckedBatch: (cb: (p: unknown) => void) => on(EVT.taskCheckedBatch, cb),
    taskStreamChange: (cb: (p: { streamerId: string; next: string; prev: string }) => void) =>
      on(EVT.taskStreamChange, cb),

    streamerChanged: (cb: (list: Streamer[]) => void) => on(EVT.streamerChanged, cb),
    streamerStatus: (cb: (s: StreamerStats) => void) => on(EVT.streamerStatus, cb),

    configChanged: (cb: (c: AppConfig) => void) => on(EVT.configChanged, cb),
    themeChanged: (cb: (p: { theme: string }) => void) => on(EVT.themeChanged, cb),

    danmakuMessage: (cb: (p: { streamerId: string; message: unknown }) => void) =>
      on(EVT.danmakuMessage, cb),
    danmakuStatus: (cb: (s: unknown) => void) => on(EVT.danmakuStatus, cb),

    transcribeProgress: (cb: (p: unknown) => void) => on(EVT.transcribeProgress, cb),
    transcribeLocalInstall: (cb: (p: unknown) => void) => on(EVT.transcribeLocalInstall, cb),
    mergeProgress: (cb: (p: unknown) => void) => on(EVT.mergeProgress, cb),
    convertProgress: (cb: (p: unknown) => void) => on(EVT.convertProgress, cb),

    importProgress: (cb: (p: unknown) => void) => on(EVT.importProgress, cb),
    importComplete: (cb: (p: unknown) => void) => on(EVT.importComplete, cb),

    historyChanged: (cb: (list: HistoryItem[]) => void) => on(EVT.historyChanged, cb),

    diskWarning: (cb: (u: DiskUsage) => void) => on(EVT.diskWarning, cb),
    diskInfo: (cb: (u: DiskUsage | DiskMonitorStatus) => void) => on(EVT.diskInfo, cb),

    hudiStatus: (cb: (s: CaptureStatus) => void) => on(EVT.hudiStatus, cb),
    hudiSources: (cb: (p: unknown) => void) => on(EVT.hudiSources, cb),

    windowMaximized: (cb: (v: boolean) => void) => on(EVT.windowMaximized, cb),
    closeRequested: (cb: () => void) => on(EVT.appCloseRequested, cb),
    systemError: (cb: (m: string) => void) => on(EVT.systemError, cb)
  }
}

contextBridge.exposeInMainWorld('api', api)
