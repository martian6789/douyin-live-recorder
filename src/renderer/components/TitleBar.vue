<script setup lang="ts">
/**
 * 自绘标题栏（窗口是 frame:false）。
 * 左侧拖拽区、右侧窗口按钮；中间顺手放监控/录制状态，省一行界面高度。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { state, setTheme } from '../store'
import logoUrl from '../assets/logo.svg'

const api = window.api
const maximized = ref(false)
let offMax: (() => void) | null = null

function minimizeWin(): void {
  void api.win.minimize()
}

function closeWin(): void {
  void api.win.close()
}

const themeIcon = computed(() => (state.theme === 'dark' ? 'Sunny' : 'Moon'))

onMounted(async () => {
  maximized.value = await window.api.win.isMaximized()
  offMax = window.api.on.windowMaximized((v) => {
    maximized.value = v
  })
})

onUnmounted(() => {
  offMax?.()
})

function toggleMax(): void {
  void window.api.win.toggleMaximize().then((v) => {
    maximized.value = v
  })
}

function onTitleDblClick(): void {
  toggleMax()
}

function cycleTheme(): void {
  void setTheme(state.theme === 'dark' ? 'light' : 'dark')
}
</script>

<template>
  <header class="titlebar" @dblclick="onTitleDblClick">
    <div class="brand">
      <img class="logo" :src="logoUrl" alt="LiveReview" draggable="false" />
      <span class="name serif">直播复盘工具</span>
      <span class="ver mono">v{{ state.system?.appVersion ?? '—' }}</span>
      <span v-if="state.system?.portable" class="tag-portable">便携版</span>
    </div>

    <div class="center">
      <span class="pill" :class="state.monitor.running ? 'recording' : 'offline'">
        <i class="dot" :class="state.monitor.running ? 'blink' : ''" :style="{ background: 'currentColor' }" />
        监控{{ state.monitor.running ? '运行中' : '已停止' }} · {{ state.monitor.taskCount }}
      </span>
      <span v-if="state.monitor.livingCount" class="pill living">
        <i class="dot blink" :style="{ background: 'currentColor' }" />
        {{ state.monitor.livingCount }} 个直播中
      </span>
      <span v-if="state.recordStats.active" class="pill recording">
        <i class="dot blink" :style="{ background: 'currentColor' }" />
        录制 {{ state.recordStats.active }}
      </span>
    </div>

    <div class="actions">
      <button class="tbtn" :title="state.theme === 'dark' ? '切换到浅色' : '切换到深色'" @click="cycleTheme">
        <el-icon><component :is="themeIcon" /></el-icon>
      </button>
      <button class="tbtn" title="最小化" @click="minimizeWin">
        <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0" y="4.5" width="10" height="1" fill="currentColor" /></svg>
      </button>
      <button class="tbtn" :title="maximized ? '还原' : '最大化'" @click="toggleMax">
        <svg v-if="!maximized" width="10" height="10" viewBox="0 0 10 10">
          <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
        </svg>
        <svg v-else width="10" height="10" viewBox="0 0 10 10">
          <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
          <path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" />
        </svg>
      </button>
      <button class="tbtn danger" title="关闭" @click="closeWin">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" fill="none" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  height: var(--titlebar-h);
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 0 0 12px;
  background: linear-gradient(180deg, var(--frame-2), var(--frame));
  border-bottom: 1px solid var(--frame-line);
  -webkit-app-region: drag;
}

.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 0 0 auto;
}
.logo {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.18);
  user-select: none;
}
.name {
  font-size: 14.5px;
  letter-spacing: 0.5px;
  color: var(--frame-ink);
}
.ver {
  color: var(--frame-ink-3);
  font-size: 12.5px;
}
.tag-portable {
  font-size: 11.5px;
  color: var(--song-bright);
  border: 1px solid rgba(109, 179, 145, 0.45);
  border-radius: 4px;
  padding: 0 5px;
  line-height: 15px;
}

.center {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
}
.center .pill {
  background: var(--frame-hover);
  color: var(--frame-ink-2);
  border: 1px solid var(--frame-line);
}
.center .pill.living {
  background: rgba(168, 50, 45, 0.22);
  color: var(--zhu-bright);
  border-color: rgba(212, 102, 95, 0.35);
}
.center .pill.recording {
  background: rgba(95, 167, 127, 0.18);
  color: var(--song-bright);
  border-color: rgba(109, 179, 145, 0.35);
}

.actions {
  display: flex;
  align-items: stretch;
  flex: 0 0 auto;
  -webkit-app-region: no-drag;
}
.tbtn {
  width: 44px;
  height: var(--titlebar-h);
  border: none;
  background: transparent;
  color: var(--frame-ink-2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s, color 0.12s;
}
.tbtn:hover {
  background: var(--frame-hover);
  color: var(--frame-ink);
}
.tbtn.danger:hover {
  background: #a8322d;
  color: #fff;
}
</style>
