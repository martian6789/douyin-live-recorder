<script setup lang="ts">
/**
 * 开播监控：轮询调度的一览。
 * 调度本身在主进程（单一定时器 + 指数退避），这里只做展示与开关。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { MonitorTask } from '@shared/types'
import { state, platformColor, platformName, refreshStats, roomLabel } from '../store'
import { fromNow, formatTime } from '../format'

const tasks = ref<MonitorTask[]>([])
const busy = ref(false)
const checking = ref('')

const living = computed(() => tasks.value.filter((t) => t.lastResult === 'living'))

async function load(): Promise<void> {
  tasks.value = await window.api.monitor.tasks()
}

async function start(): Promise<void> {
  busy.value = true
  try {
    await window.api.monitor.start()
    await Promise.all([load(), refreshStats()])
    ElMessage.success('监控已启动')
  } finally {
    busy.value = false
  }
}

async function stop(): Promise<void> {
  busy.value = true
  try {
    await window.api.monitor.stop()
    await Promise.all([load(), refreshStats()])
    ElMessage.info('监控已停止')
  } finally {
    busy.value = false
  }
}

async function resumeAll(): Promise<void> {
  tasks.value = await window.api.monitor.resume()
  ElMessage.success('已重置全部任务的检测时间')
}

async function checkOne(t: MonitorTask): Promise<void> {
  checking.value = t.streamerId
  try {
    const r = await window.api.monitor.checkOne(t.streamerId)
    t.lastResult = r.status as MonitorTask['lastResult']
    await refreshStats()
    ElMessage[r.status === 'error' ? 'warning' : 'success'](
      r.status === 'living' ? '正在直播' : r.status === 'offline' ? '未开播' : `失败：${r.error ?? ''}`
    )
  } finally {
    checking.value = ''
  }
}

async function removeTask(t: MonitorTask): Promise<void> {
  tasks.value = await window.api.monitor.removeTask(t.streamerId)
  ElMessage.info('已从监控队列移除（主播仍在库中）')
}

async function startRecord(t: MonitorTask): Promise<void> {
  try {
    await window.api.record.start(t.streamerId)
    await refreshStats()
    state.view = 'recording'
  } catch (e: unknown) {
    ElMessage.error(`录制失败：${(e as Error)?.message ?? e}`)
  }
}

let timer: number | null = null

onMounted(() => {
  void load()
  // 任务表里的「下次检测时间」需要持续走字，低频刷新即可
  timer = window.setInterval(() => void load(), 5000)
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h2>开播监控</h2>
        <p class="hint">
          轮询间隔 {{ state.config?.checkIntervalSec ?? '—' }} 秒 · 任务 {{ tasks.length }} 个 ·
          直播中 {{ living.length }} 个 · 累计检测 {{ state.monitor.checkedCount }} 次
        </p>
      </div>
      <div class="head-actions">
        <el-button @click="resumeAll"><el-icon><RefreshRight /></el-icon>重置检测时间</el-button>
        <el-button v-if="!state.monitor.running" type="primary" :loading="busy" @click="start">
          <el-icon><VideoPlay /></el-icon>启动监控
        </el-button>
        <el-button v-else type="danger" plain :loading="busy" @click="stop">
          <el-icon><VideoPause /></el-icon>停止监控
        </el-button>
      </div>
    </header>

    <section class="panel stats">
      <div class="s-item">
        <span class="k">调度状态</span>
        <b :class="state.monitor.running ? 'ok' : 'bad'">{{ state.monitor.running ? '运行中' : '已停止' }}</b>
      </div>
      <div class="s-item"><span class="k">任务数</span><b>{{ tasks.length }}</b></div>
      <div class="s-item"><span class="k">直播中</span><b class="zhu">{{ living.length }}</b></div>
      <div class="s-item"><span class="k">失败次数</span><b :class="{ bad: state.monitor.errorCount > 0 }">{{ state.monitor.errorCount }}</b></div>
      <div class="s-item">
        <span class="k">上轮开始</span><b>{{ state.monitor.lastRoundAt ? formatTime(state.monitor.lastRoundAt, false) : '—' }}</b>
      </div>
      <div class="s-item">
        <span class="k">磁盘</span>
        <b :class="{ bad: state.diskUsage?.warning }">
          {{ state.disk?.running ? '看护中' : '未开启' }}
        </b>
      </div>
    </section>

    <section class="panel table-wrap">
      <el-table :data="tasks" size="small" height="100%" empty-text="监控队列为空，先在主播库添加">
        <el-table-column label="主播" min-width="200">
          <template #default="{ row }">
            <span class="plat">
              <i class="dot" :style="{ background: platformColor(row.platform) }" />
              <span class="nm">{{ row.name }}</span>
              <span class="mono rid">{{ roomLabel(row) }}</span>
            </span>
          </template>
        </el-table-column>

        <el-table-column label="平台" width="100">
          <template #default="{ row }">{{ platformName(row.platform) }}</template>
        </el-table-column>

        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <span class="pill" :class="row.lastResult === 'living' ? 'living' : row.lastResult === 'error' ? 'error' : 'offline'">
              <i v-if="row.lastResult === 'living'" class="dot blink" :style="{ background: 'currentColor' }" />
              {{ row.lastResult === 'living' ? '直播中' : row.lastResult === 'error' ? '检测失败' : '未开播' }}
            </span>
          </template>
        </el-table-column>

        <el-table-column label="间隔" width="76">
          <template #default="{ row }">{{ row.intervalSec }}s</template>
        </el-table-column>

        <el-table-column label="下次检测" width="110">
          <template #default="{ row }">
            <span class="mono">{{ row.nextCheckAt > Date.now() ? fromNow(row.nextCheckAt) : '即将' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="连续失败" width="86" align="center">
          <template #default="{ row }">
            <span :class="{ bad: row.consecutiveErrors > 0 }">{{ row.consecutiveErrors }}</span>
          </template>
        </el-table-column>

        <el-table-column label="自动录" width="70" align="center">
          <template #default="{ row }">
            <el-icon :class="state.streamers.find((s) => s.id === row.streamerId)?.autoRecord ? 'ok' : 'dim'">
              <component :is="state.streamers.find((s) => s.id === row.streamerId)?.autoRecord ? 'Select' : 'Minus'" />
            </el-icon>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :loading="checking === row.streamerId" @click="checkOne(row)">立即检测</el-button>
            <el-button size="small" type="primary" plain :disabled="row.lastResult !== 'living'" @click="startRecord(row)">
              录制
            </el-button>
            <el-button size="small" type="danger" link @click="removeTask(row)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 12px;
  flex: 0 0 auto;
}
.page-head h2 {
  margin: 0 0 2px;
  font-size: 18px;
}
.head-actions {
  display: flex;
  gap: 6px;
}

.stats {
  display: flex;
  gap: 22px;
  padding: 10px 14px;
  margin-bottom: 10px;
  flex: 0 0 auto;
  flex-wrap: wrap;
}
.s-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.s-item .k {
  color: var(--ink-3);
  font-size: 12.5px;
}
.s-item b {
  font-family: var(--font-serif);
  font-size: 14px;
}
.ok {
  color: var(--song);
}
.bad {
  color: var(--zhu);
}
.zhu {
  color: var(--zhu);
}
.dim {
  color: var(--ink-4);
}

.table-wrap {
  flex: 1 1 auto;
  min-height: 0;
  padding: 4px;
  overflow: hidden;
}
.plat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.nm {
  font-weight: 600;
}
.rid {
  color: var(--ink-4);
}
</style>
