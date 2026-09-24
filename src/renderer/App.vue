<script setup lang="ts">
/**
 * 应用外壳：标题栏 + 侧栏导航 + 内容区 + 状态栏。
 *
 * 不做 vue-router：导航项固定且只有一级，用一个响应式的 view 字段切换即可，
 * 少一个依赖也少一层跳转带来的状态丢失。
 */
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import TitleBar from './components/TitleBar.vue'
import { state, init, refreshDisk, type ViewId } from './store'
import { formatBytes } from './format'

import DashboardView from './views/DashboardView.vue'
import MonitorView from './views/MonitorView.vue'
import StreamersView from './views/StreamersView.vue'
import RecordingView from './views/RecordingView.vue'
import LibraryView from './views/LibraryView.vue'
import HistoryView from './views/HistoryView.vue'
import TranscribeView from './views/TranscribeView.vue'
import ToolsView from './views/ToolsView.vue'
import CaptureView from './views/CaptureView.vue'
import SettingsView from './views/SettingsView.vue'
import LogsView from './views/LogsView.vue'
import AboutView from './views/AboutView.vue'

interface NavItem {
  id: ViewId
  label: string
  icon: string
  group: string
}

const NAV: NavItem[] = [
  { id: 'dashboard', label: '概览', icon: 'Odometer', group: '' },
  { id: 'monitor', label: '开播监控', icon: 'AlarmClock', group: '监控' },
  { id: 'streamers', label: '主播库', icon: 'UserFilled', group: '' },
  { id: 'recording', label: '录制中心', icon: 'VideoCamera', group: '录制' },
  { id: 'library', label: '录像库', icon: 'FolderOpened', group: '' },
  { id: 'history', label: '录制历史', icon: 'Timer', group: '' },
  { id: 'transcribe', label: '语音转写', icon: 'Microphone', group: '工具' },
  { id: 'tools', label: '合并转码', icon: 'Tools', group: '' },
  { id: 'capture', label: '视频号捕获', icon: 'Camera', group: '' },
  { id: 'logs', label: '运行日志', icon: 'Document', group: '' },
  { id: 'settings', label: '设置', icon: 'Setting', group: '系统' },
  { id: 'about', label: '关于', icon: 'InfoFilled', group: '' }
]

const views: Record<ViewId, unknown> = {
  dashboard: DashboardView,
  monitor: MonitorView,
  streamers: StreamersView,
  recording: RecordingView,
  library: LibraryView,
  history: HistoryView,
  transcribe: TranscribeView,
  tools: ToolsView,
  capture: CaptureView,
  logs: LogsView,
  settings: SettingsView,
  about: AboutView
}

const current = shallowRef<unknown>(DashboardView)
const booting = ref(true)
const firstRun = ref(false)

const badge = (id: ViewId): number | null => {
  if (id === 'monitor') return state.monitor.livingCount || null
  if (id === 'recording') return state.recordStats.active || null
  if (id === 'streamers') return state.streamers.length || null
  return null
}

const taskText = computed(() => {
  const t = state.tasks
  const parts: string[] = []
  if (t.transcribe?.total) parts.push(`转写 ${t.transcribe.done}/${t.transcribe.total}`)
  if (t.merge?.total) parts.push(`合并 ${t.merge.done}/${t.merge.total}`)
  if (t.convert?.total) parts.push(`转码 ${t.convert.done}/${t.convert.total}`)
  if (t.import?.total) parts.push(`导入 ${t.import.done}/${t.import.total}`)
  return parts.join(' · ')
})

function go(id: ViewId): void {
  state.view = id
  current.value = views[id]
}

async function runDiskCheck(): Promise<void> {
  const r = await window.api.disk.runCheck()
  await refreshDisk()
  ElMessage.info(
    `剩余 ${formatBytes(r.usage.freeBytes)} / 共 ${formatBytes(r.usage.totalBytes)}（已用 ${r.usage.usedPercent}%）`
  )
}

let offClose: (() => void) | null = null
let timer: number | null = null

onMounted(async () => {
  try {
    await init()
  } catch (e: unknown) {
    ElMessage.error(`初始化失败：${(e as Error)?.message ?? e}`)
  } finally {
    booting.value = false
  }

  firstRun.value = await window.api.app.checkFirstRun()

  offClose = window.api.on.closeRequested(() => {
    ElMessage({
      message: '窗口已最小化到托盘，双击托盘图标可恢复；在「设置」里可改为直接退出。',
      type: 'info',
      duration: 3000
    })
  })

  // 磁盘与统计的兜底轮询（低频，避免频繁 IPC）
  timer = window.setInterval(() => {
    void refreshDisk()
  }, 60_000)
})

onUnmounted(() => {
  offClose?.()
  if (timer) window.clearInterval(timer)
})

async function finishFirstRun(): Promise<void> {
  await window.api.app.setFirstRunCompleted()
  firstRun.value = false
  ElMessage.success('已就绪，去「主播库」添加第一个直播间吧')
}

async function openOutput(): Promise<void> {
  if (!state.config?.outputDir) return
  await window.api.library.openDirectory(state.config.outputDir)
}

function quickAdd(): void {
  go('streamers')
}

async function confirmQuit(): Promise<void> {
  try {
    await ElMessageBox.confirm('确定要退出程序吗？正在进行的录制会被停止。', '退出确认', {
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await window.api.app.quit()
  } catch {
    /* 取消 */
  }
}
</script>

<template>
  <div class="shell">
    <TitleBar />

    <div class="body">
      <aside class="sidebar">
        <nav>
          <template v-for="(item, idx) in NAV" :key="item.id">
            <div v-if="item.group" class="nav-group">{{ item.group }}</div>
            <button
              class="nav-item"
              :class="{ active: state.view === item.id }"
              @click="go(item.id)"
            >
              <el-icon class="ico"><component :is="item.icon" /></el-icon>
              <span class="label">{{ item.label }}</span>
              <span v-if="badge(item.id)" class="badge" :class="{ blink: item.id === 'recording' }">{{
                badge(item.id)
              }}</span>
            </button>
          </template>
        </nav>

        <div class="sidebar-foot">
          <div class="foot-row"><span class="k">输出目录</span></div>
          <div class="foot-path mono" :title="state.config?.outputDir" @click="openOutput">
            {{ state.config?.outputDir ?? '—' }}
          </div>
          <div class="foot-row">
            <span class="k">磁盘剩余</span>
            <span class="v" :class="{ warn: state.diskUsage?.warning }">
              {{ state.diskUsage ? formatBytes(state.diskUsage.freeBytes) : '—' }}
            </span>
          </div>
        </div>
      </aside>

      <main class="content">
        <div v-if="booting" class="empty">正在载入…</div>
        <Transition v-else name="fade" mode="out-in">
          <component :is="current" :key="state.view" />
        </Transition>
      </main>
    </div>

    <footer class="statusbar">
      <span class="sb-item">
        <el-icon><Cpu /></el-icon>
        Electron {{ state.system?.electron ?? '—' }} · ffmpeg
        <b :class="state.system?.ffmpeg.source === 'none' ? 'bad' : 'ok'">
          {{ state.system?.ffmpeg.source === 'none' ? '未找到' : state.system?.ffmpeg.version || '已就绪' }}
        </b>
      </span>
      <span v-if="taskText" class="sb-item"><el-icon><Loading /></el-icon>{{ taskText }}</span>
      <span v-if="state.monitor.checkedCount" class="sb-item">
        <el-icon><Refresh /></el-icon>已检测 {{ state.monitor.checkedCount }} 次
      </span>
      <span v-if="state.monitor.errorCount" class="sb-item warn">
        <el-icon><Warning /></el-icon>失败 {{ state.monitor.errorCount }}
      </span>

      <span class="sb-spacer" />

      <span class="sb-item link" @click="runDiskCheck">
        <el-icon><Coin /></el-icon>磁盘检查
      </span>
      <span class="sb-item link" @click="go('logs')">
        <el-icon><Document /></el-icon>日志
      </span>
      <span class="sb-item link" @click="quickAdd"><el-icon><Plus /></el-icon>添加主播</span>
      <span class="sb-item link" @click="confirmQuit"><el-icon><SwitchButton /></el-icon>退出</span>
    </footer>

    <!-- 首次运行引导 -->
    <el-dialog v-model="firstRun" title="欢迎使用直播复盘工具" width="560" :close-on-click-modal="false">
      <div class="guide">
        <p>三步就能开始无人值守录制：</p>
        <ol>
          <li>
            <b>填输出目录</b>：默认放在数据目录下的 <span class="mono">recordings/</span>，可在「设置 → 通用」修改。
          </li>
          <li><b>添加直播间</b>：支持直接粘贴分享链接，五个平台 + 微信视频号捕获。</li>
          <li><b>打开监控</b>：勾选主播的「自动录制」，开播即录，断流会自动重连。</li>
        </ol>
        <p class="hint">
          与原版最大的不同：视频号录制走「窗口/屏幕捕获 + 系统音频」，不再接管系统代理、
          不安装根证书，因此不会影响机器上其它程序的 HTTPS 通信。
        </p>
      </div>
      <template #footer>
        <el-button @click="firstRun = false">稍后再说</el-button>
        <el-button type="primary" @click="finishFirstRun">开始使用</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}

.body {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
}

/* ------------------------------------------------------------- 侧栏（深墨框架） */
.sidebar {
  width: var(--sidebar-w);
  flex: 0 0 auto;
  background: linear-gradient(180deg, var(--frame-2), var(--frame) 240px);
  border-right: 1px solid var(--frame-line);
  display: flex;
  flex-direction: column;
  padding: 10px 0 8px;
  overflow: hidden;
}

nav {
  flex: 1 1 auto;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 10px;
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--frame-ink-2);
  font-size: 14px;
  font-family: var(--font-ui);
  text-align: left;
  cursor: pointer;
  transition: background 0.14s, color 0.14s;
}
.nav-item:hover {
  background: var(--frame-hover);
  color: var(--frame-ink);
}
.nav-item.active {
  background: linear-gradient(92deg, #a8322d, #8c2723);
  color: #fff;
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.14);
}
.nav-item.active .ico {
  color: #fff;
}
/* 分组小标题 */
.nav-group {
  margin: 12px 12px 3px;
  font-size: 11.5px;
  letter-spacing: 2.5px;
  color: var(--frame-ink-3);
  user-select: none;
}
nav .nav-group:first-child {
  margin-top: 2px;
}
.ico {
  font-size: 17px;
  color: var(--frame-ink-3);
  transition: color 0.14s;
}
.nav-item:hover .ico {
  color: var(--frame-ink-2);
}
.label {
  flex: 1 1 auto;
}
.badge {
  background: #a8322d;
  color: #fff;
  border-radius: 9px;
  font-size: 11px;
  line-height: 17px;
  padding: 0 6px;
  min-width: 17px;
  text-align: center;
}
.nav-item.active .badge {
  background: rgba(255, 255, 255, 0.92);
  color: #8c2723;
}

.sidebar-foot {
  flex: 0 0 auto;
  margin: 8px 10px 2px;
  padding: 10px 12px 8px;
  border-top: 1px solid var(--frame-line);
  font-size: 12px;
  color: var(--frame-ink-3);
}
.foot-row {
  display: flex;
  justify-content: space-between;
  margin-top: 5px;
}
.foot-row .k {
  color: var(--frame-ink-3);
}
.foot-row .v {
  color: var(--frame-ink-2);
}
.foot-path {
  color: var(--frame-ink-2);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
  border-radius: 4px;
}
.foot-path:hover {
  color: var(--zhu-bright);
}
.v.warn {
  color: #d9a93a;
  font-weight: 600;
}

/* ----------------------------------------------------------- 内容区 */
.content {
  flex: 1 1 auto;
  min-width: 0;
  overflow: auto;
  padding: 20px 26px 26px;
}

/* ----------------------------------------------------------- 状态栏 */
.statusbar {
  flex: 0 0 auto;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 14px;
  background: var(--paper-2);
  border-top: 1px solid var(--line);
  font-size: 12.5px;
  color: var(--ink-3);
}
.sb-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.sb-item b.ok {
  color: var(--song);
  font-weight: 600;
}
.sb-item b.bad {
  color: var(--zhu);
  font-weight: 600;
}
.sb-item.warn {
  color: var(--jin);
}
.sb-item.gm {
  color: var(--zhu);
  font-weight: 600;
}
.sb-item.link {
  cursor: pointer;
}
.sb-item.link:hover {
  color: var(--zhu);
}
.sb-spacer {
  flex: 1 1 auto;
}

/* --------------------------------------------------------------- 引导 */
.guide ol {
  margin: 8px 0 12px;
  padding-left: 20px;
}
.guide li {
  margin-bottom: 6px;
}
.guide .hint {
  background: var(--song-soft);
  border-left: 3px solid var(--song);
  padding: 8px 10px;
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: var(--ink-2);
}
</style>
