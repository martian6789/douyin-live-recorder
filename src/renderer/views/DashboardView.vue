<script setup lang="ts">
/** 概览：一眼看清「有几个在播、录了几个、盘还剩多少、环境齐不齐」。 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { state, platformColor, platformName, refreshDisk, refreshStats } from '../store'
import { formatBytes, formatDuration, fromNow } from '../format'

const busy = ref(false)

const cards = computed(() => [
  { label: '主播总数', value: state.streamers.length, sub: `自动录制 ${state.streamers.filter((s) => s.autoRecord).length}`, color: 'var(--ink)' },
  { label: '正在直播', value: state.monitor.livingCount, sub: `监控任务 ${state.monitor.taskCount}`, color: 'var(--zhu)' },
  { label: '录制中', value: state.recordStats.active, sub: `今日 ${state.recordStats.totalToday} 个`, color: 'var(--song)' },
  { label: '今日产出', value: formatBytes(state.recordStats.bytesToday), sub: `时长 ${formatDuration(state.recordStats.durationTodayMs)}`, color: 'var(--jin)' }
])

const living = computed(() => state.streamers.filter((s) => s.liveStatus === 'living'))

const recent = computed(() =>
  [...state.history].sort((a, b) => b.endedAt - a.endedAt).slice(0, 8)
)

const env = computed(() => {
  const items: { label: string; ok: boolean; text: string; action?: string }[] = []
  const ff = state.system?.ffmpeg
  items.push({
    label: 'ffmpeg',
    ok: ff?.source !== 'none',
    text: ff?.source === 'none' ? '未找到，无法录制' : `${ff?.version || '已就绪'}（${ff?.source}）`,
    action: 'settings'
  })
  items.push({
    label: '输出目录',
    ok: !!state.config?.outputDir,
    text: state.config?.outputDir ?? '未设置',
    action: 'settings'
  })
  const d = state.disk
  items.push({
    label: '磁盘监控',
    ok: !!d?.running,
    text: d?.running
      ? `运行中，阈值 ${state.config?.disk.minFreeGB}GB`
      : '未开启（可在设置里打开）',
    action: 'settings'
  })
  const du = state.diskUsage
  items.push({
    label: '剩余空间',
    ok: !du?.warning,
    text: du ? `${formatBytes(du.freeBytes)}（已用 ${du.usedPercent}%）` : '未检测',
    action: 'disk'
  })
  return items
})

async function refresh(): Promise<void> {
  busy.value = true
  try {
    await Promise.all([refreshStats(), refreshDisk(), window.api.streamer.refresh().then((l) => (state.streamers = l))])
  } finally {
    busy.value = false
  }
}

function gotoSettings(): void {
  state.view = 'settings'
}

function gotoView(v: typeof state.view): void {
  state.view = v
}

async function runDisk(): Promise<void> {
  const r = await window.api.disk.runCheck()
  await refreshDisk()
  ElMessage.info(`剩余 ${formatBytes(r.usage.freeBytes)}`)
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <div class="dash">
    <header class="page-head">
      <div>
        <h2>概览</h2>
        <p class="hint">
          监控 {{ state.monitor.running ? '运行中' : '已停止' }} ·
          累计检测 {{ state.monitor.checkedCount }} 次 · 失败 {{ state.monitor.errorCount }} 次
        </p>
      </div>
      <el-button :loading="busy" @click="refresh">
        <el-icon><Refresh /></el-icon>刷新
      </el-button>
    </header>

    <section class="cards">
      <div v-for="c in cards" :key="c.label" class="panel stat" :style="{ color: c.color }">
        <div class="stat-label">{{ c.label }}</div>
        <div class="stat-value">{{ c.value }}</div>
        <div class="stat-sub hint">{{ c.sub }}</div>
      </div>
    </section>

    <div class="grid">
      <section class="panel block">
        <div class="block-head">
          <span class="panel-title">正在直播</span>
          <el-button link @click="gotoView('monitor')">去监控 →</el-button>
        </div>
        <div v-if="!living.length" class="empty">暂无主播在播</div>
        <ul v-else class="living-list">
          <li v-for="s in living" :key="s.id">
            <i class="dot blink" :style="{ background: platformColor(s.platform) }" />
            <span class="nm">{{ s.name }}</span>
            <span class="pill" :class="{ recording: s.autoRecord }">
              {{ s.autoRecord ? '自动录制' : '仅监控' }}
            </span>
            <span class="hint">{{ fromNow(s.lastCheckAt) }}</span>
          </li>
        </ul>
      </section>

      <section class="panel block">
        <div class="block-head">
          <span class="panel-title">最近录制</span>
          <el-button link @click="gotoView('history')">全部历史 →</el-button>
        </div>
        <div v-if="!recent.length" class="empty">还没有录制记录</div>
        <ul v-else class="recent-list">
          <li v-for="h in recent" :key="h.id">
            <i class="dot" :style="{ background: platformColor(h.platform) }" />
            <span class="nm">{{ h.streamerName }}</span>
            <span class="mono size">{{ formatBytes(h.sizeBytes) }}</span>
            <span class="mono dur">{{ formatDuration(h.durationMs) }}</span>
            <span class="hint">{{ fromNow(h.endedAt) }}</span>
          </li>
        </ul>
      </section>
    </div>

    <section class="panel block">
      <div class="block-head">
        <span class="panel-title">环境体检</span>
        <el-button link @click="gotoSettings">去设置 →</el-button>
      </div>
      <ul class="env-list">
        <li v-for="e in env" :key="e.label">
          <el-icon :class="e.ok ? 'ok' : 'bad'">
            <component :is="e.ok ? 'CircleCheckFilled' : 'WarningFilled'" />
          </el-icon>
          <span class="lbl">{{ e.label }}</span>
          <span class="txt mono" :title="e.text">{{ e.text }}</span>
          <el-button v-if="e.action === 'disk'" link size="small" @click="runDisk">立即检测</el-button>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 16px;
}
.page-head h2 {
  margin: 0 0 3px;
  font-size: 22px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 16px;
}
.stat {
  position: relative;
  padding: 14px 16px 12px;
  overflow: hidden;
}
/* 统计卡顶部主色细条，按卡内颜色渲染 */
.stat::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: currentColor;
  opacity: 0.85;
}
.stat-label {
  font-size: 14px;
  color: var(--ink-3);
  letter-spacing: 0.5px;
}
.stat-value {
  font-family: var(--font-serif);
  font-size: 30px;
  line-height: 1.3;
  font-weight: 600;
}
.stat-sub {
  font-size: 13.5px;
}

.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 14px;
  margin-bottom: 16px;
}

.block {
  padding: 14px 16px 8px;
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.living-list,
.recent-list,
.env-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.living-list li,
.recent-list li {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--line);
  font-size: 14px;
}
.living-list li:last-child,
.recent-list li:last-child {
  border-bottom: none;
}
.nm {
  flex: 0 0 auto;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.tt {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
}
.recent-list .size,
.recent-list .dur {
  flex: 0 0 auto;
  color: var(--ink-2);
}
.recent-list .hint {
  margin-left: auto;
  flex: 0 0 auto;
}

.env-list li {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 0;
  border-bottom: 1px dashed var(--line);
}
.env-list li:last-child {
  border-bottom: none;
}
.env-list .ok {
  color: var(--song);
}
.env-list .bad {
  color: var(--zhu);
}
.env-list .lbl {
  flex: 0 0 90px;
  color: var(--ink-2);
  font-size: 14px;
}
.env-list .txt {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
}
</style>
