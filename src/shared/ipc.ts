/**
 * IPC 通道名集中定义 —— 与原始软件（live_record_auto_pro 1.3.0）的通道命名保持一致，
 * 便于对照、也便于以前端日志定位问题。
 *
 * 命名约定：`模块:动作`。事件推送统一以 `-changed` / `progress` / `started` / `ended` 结尾。
 */

export const IPC = {
  /* ---------------- app ---------------- */
  appGetInfo: 'app:get-info',
  appGetAutoStartup: 'app:get-auto-startup',
  appSetAutoStartup: 'app:set-auto-startup',
  appCheckVersionUpdate: 'app:check-version-update',
  appCheckFirstRun: 'app:check-first-run',
  appSetFirstRunCompleted: 'app:set-first-run-completed',
  appOpenExternal: 'app:open-external',
  appOpenLogDirectory: 'app:open-log-directory',
  appShowInFolder: 'app:show-in-folder',
  appQuit: 'app:quit',

  /* ---------------- window（自定义标题栏） ---------------- */
  windowMinimize: 'window:minimize-with-behavior',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',

  /* ---------------- config ---------------- */
  configGet: 'config:get',
  configSet: 'config:set',
  configSetMultiple: 'config:set-multiple',
  configReset: 'config:reset',
  configSelectDirectory: 'config:select-directory',
  configOpenSaveDirectory: 'config:open-save-directory',
  configGetTemplateVariables: 'config:get-template-variables',
  configValidateTemplate: 'config:validate-template',
  configPreviewTemplate: 'config:preview-template',

  /* ---------------- credential（各平台 Cookie） ---------------- */
  credentialSet: 'credential:set',
  credentialClear: 'credential:clear',
  credentialGetAllStatus: 'credential:get-all-status',
  credentialValidate: 'credential:validate',

  /* ---------------- streamer（主播库） ---------------- */
  streamerGetAll: 'streamer:get-all',
  streamerGetById: 'streamer:get-by-id',
  streamerGetByTags: 'streamer:get-by-tags',
  streamerAdd: 'streamer:add',
  streamerBatchAdd: 'streamer:batch-add',
  streamerUpdate: 'streamer:update',
  streamerDelete: 'streamer:delete',
  streamerCheckExists: 'streamer:check-exists',
  streamerBatchCheckExists: 'streamer:batch-check-exists',
  streamerToggleAutoRecord: 'streamer:toggle-auto-record',
  streamerToggleTop: 'streamer:toggle-top',
  streamerMoveUp: 'streamer:move-up',
  streamerMoveDown: 'streamer:move-down',
  streamerMoveToBottom: 'streamer:move-to-bottom',
  streamerResetPosition: 'streamer:reset-position',
  streamerGetStats: 'streamer:get-stats',
  streamerExportData: 'streamer:export-data',
  streamerImportData: 'streamer:import-data',
  streamerOpenSaveDirectory: 'streamer:open-save-directory',
  streamerInitMonitor: 'streamer:init-monitor',
  streamerRefresh: 'streamer:refresh',
  streamerDouyinSearch: 'streamer:douyin-search',
  streamerDouyinFollowing: 'streamer:douyin-following',
  streamerImportDouyinUsers: 'streamer:import-douyin-users',
  streamerResolveAdd: 'streamer:resolve-add',

  /* ---------------- douyin（内置登录窗口取 Cookie） ---------------- */
  douyinLoginOpen: 'douyin:login-open',
  douyinLoginImport: 'douyin:login-import',

  /* ---------------- tags ---------------- */
  tagsGet: 'tags:get-user-tags',
  tagsAdd: 'tags:add-user-tag',
  tagsAddBatch: 'tags:add-user-tags-batch',
  tagsUpdate: 'tags:update-user-tag',
  tagsDelete: 'tags:delete-user-tag',

  /* ---------------- link（链接解析） ---------------- */
  linkParse: 'link:parse',
  linkBatchParse: 'link:batch-parse',

  /* ---------------- monitor（开播监控） ---------------- */
  monitorAddTask: 'monitor:add-task',
  monitorRemoveTask: 'monitor:remove-task',
  monitorGetAllTasks: 'monitor:get-all-tasks',
  monitorGetStats: 'monitor:get-stats',
  monitorGetStatus: 'monitor:get-status',
  monitorStart: 'monitor:start',
  monitorStop: 'monitor:stop',
  monitorResumeTaskMonitoring: 'monitor:resume-task-monitoring',
  monitorCheckOne: 'monitor:check-one',

  /* ---------------- record（录制） ---------------- */
  recordManualStart: 'record:manual-start',
  recordManualStop: 'record:manual-stop',
  recordStopAll: 'record:stop-all',
  recordIsRecording: 'record:is-recording',
  recordGetAllActive: 'record:get-all-active',
  recordGetStats: 'record:get-stats',

  /* ---------------- preview（内置播放器） ---------------- */
  previewStart: 'preview:start',
  previewStopAll: 'preview:stop-all',
  previewRoomInfo: 'preview:room-info',
  previewStreams: 'preview:streams',

  /* ---------------- danmaku ---------------- */
  danmakuGetStatus: 'danmaku:get-status',
  danmakuSetStreamerEnabled: 'danmaku:set-streamer-enabled',
  danmakuSubscribe: 'danmaku:subscribe',
  danmakuUnsubscribe: 'danmaku:unsubscribe',

  /* ---------------- history（录制历史） ---------------- */
  historyGetAll: 'history:get-all',
  historyDelete: 'history:delete',
  historyClear: 'history:clear',
  historyOpenDirectory: 'history:open-directory',

  /* ---------------- library（录像库） ---------------- */
  libraryScan: 'library:scan',
  libraryDeleteFile: 'library:delete-file',
  libraryOpenFile: 'library:open-file',
  libraryOpenDirectory: 'library:open-directory',

  /* ---------------- transcribe（转写） ---------------- */
  transcribeCheckLocalEnvironment: 'transcribe:check-local-environment',
  transcribeInstallLocalDependencies: 'transcribe:install-local-dependencies',
  transcribeDownloadLocalModels: 'transcribe:download-local-models',
  transcribeGetSettings: 'transcribe:get-settings',
  transcribeSaveSettings: 'transcribe:save-settings',
  transcribeScanRecordDirectory: 'transcribe:scan-record-directory',
  transcribeSelectFiles: 'transcribe:select-files',
  transcribeSelectFolder: 'transcribe:select-folder',
  transcribeSelectLocalModelRoot: 'transcribe:select-local-model-root',
  transcribeStartBatch: 'transcribe:start-batch',
  transcribeStop: 'transcribe:stop',
  transcribeDeleteFiles: 'transcribe:delete-files',
  transcribeJobs: 'transcribe:jobs',

  /* ---------------- merger（分段合并） ---------------- */
  mergerScanRecordDirectory: 'merger:scan-record-directory',
  mergerSelectFolder: 'merger:select-folder',
  mergerStartBatchMerge: 'merger:start-batch-merge',
  mergerStop: 'merger:stop',
  mergerGetAutoTasks: 'merger:get-auto-tasks',
  mergerClearAutoTasks: 'merger:clear-auto-tasks',

  /* ---------------- converter（批量转码） ---------------- */
  converterScanRecordDirectory: 'converter:scan-record-directory',
  converterSelectFolder: 'converter:select-folder',
  converterStartBatchConvert: 'converter:start-batch-convert',

  /* ---------------- hudi（视频号 · 捕获模式） ---------------- */
  hudiGetStatus: 'hudi:get-status',
  hudiListSources: 'hudi:list-sources',
  hudiListAudioDevices: 'hudi:list-audio-devices',
  hudiSetConfig: 'hudi:set-config',
  hudiStartRecord: 'hudi:start-record',
  hudiStopRecord: 'hudi:stop-record',

  /* ---------------- disk ---------------- */
  diskGetUsage: 'disk:get-usage',
  diskGetMonitorStatus: 'disk:get-monitor-status',
  diskRestartMonitor: 'disk:restart-monitor',
  diskRunCheck: 'disk:run-check',

  /* ---------------- notify ---------------- */
  notifyTest: 'webhook:test',

  /* ---------------- theme ---------------- */
  themeGet: 'theme:get',
  themeSet: 'theme:set',

  /* ---------------- log（运行日志） ---------------- */
  logTail: 'log:tail',
  logWrite: 'log:write',

  /* ---------------- system ---------------- */
  systemGetInfo: 'system:get-info',
  systemOpenDevTools: 'system:open-devtools'
} as const

/** 主进程 → 渲染进程 的推送事件 */
export const EVT = {
  /** 窗口最大化状态变化 */
  windowMaximized: 'window:maximized-changed',

  /** 录制任务状态（含进度） */
  recordStatus: 'record:status-changed',
  recordingStarted: 'recording:started',
  recordingProgress: 'recording:progress',
  recordingEnded: 'recording:ended',
  recordingError: 'recording:error',
  recordingStreamChange: 'recording:stream-change-detected',

  /** 监控 */
  monitorStatus: 'monitor:status-changed',
  monitorStarted: 'monitor:started',
  monitorStopped: 'monitor:stopped',
  taskChecked: 'task:check-result-changed',
  taskCheckedBatch: 'task:check-results-batch-changed',
  taskStreamChange: 'task:stream-change',

  /** 主播库 */
  streamerChanged: 'streamer:data-reloaded',
  streamerStatus: 'streamer:status-changed',

  /** 配置 */
  configChanged: 'config:changed',
  themeChanged: 'theme:changed',

  /** 弹幕 */
  danmakuMessage: 'danmaku:message',
  danmakuStatus: 'danmaku:status-changed',

  /** 任务进度 */
  transcribeProgress: 'transcribe:progress',
  transcribeLocalInstall: 'transcribe:local-install-progress',
  mergeProgress: 'merge:progress',
  mergeCompleted: 'segments:convert-completed',
  convertStarted: 'convert:started',
  convertProgress: 'convert:progress',
  convertCompleted: 'convert:completed',
  convertFailed: 'convert:failed',

  /** 批量导入 / 解析 */
  importProgress: 'import:progress',
  importComplete: 'import:complete',
  importError: 'import:error',

  /** 历史 */
  historyChanged: 'history:changed',
  sourceDeleted: 'source:deleted',

  /** 磁盘 */
  diskWarning: 'system:warning',
  diskInfo: 'disk:info',

  /** 视频号捕获 */
  hudiStatus: 'hudi:proxy-status-changed',
  hudiSources: 'hudi:captures-changed',

  /** 应用级 */
  appReady: 'app:ready',
  appCloseRequested: 'app:close-requested',
  appBeforeQuit: 'app:before-quit',
  appNotification: 'app:notification',
  systemError: 'system:error'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
export type EventChannel = (typeof EVT)[keyof typeof EVT]
