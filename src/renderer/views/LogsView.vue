<script setup lang="ts">
/**
 * 运行日志：直接展示主进程写的日志文件尾部（按天滚动）。
 *
 * 目的：出问题时不用截图 —— 这里就能看到 relay / ffmpeg / 播放器 / 抖音接口的错误，
 * 也可以一键复制或导出给他人排查。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

const file = ref('')
const lines = ref<string[]>([])
const loading = ref(false)
const auto = ref(true)
const keyword = ref('')
const onlyError = ref(false)
let timer: number | null = null

async function load(): Promise<void> {
  loading.value = true
  try {
    const r = await window.api.log.tail(800)
    file.value = r.file
    lines.value = r.lines
  } catch (e: unknown) {
    ElMessage.error(`读取日志失败：${(e as Error)?.message ?? e}`)
  } finally {
    loading.value = false
  }
}

const rows = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return lines.value
    .filter((l) => (onlyError.value ? /\[(ERROR|WARN)\]/.test(l) : true))
    .filter((l) => (kw ? l.toLowerCase().includes(kw) : true))
    .slice()
    .reverse()
})

function levelOf(line: string): string {
  const m = /\[(DEBUG|INFO|WARN|ERROR)\]/.exec(line)
  return m ? m[1] : 'INFO'
}

async function copyAll(): Promise<void> {
  const text = rows.value.join('\n')
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(`已复制 ${rows.value.length} 行到剪贴板`)
  } catch {
    ElMessage.warning('剪贴板不可用，请手动选中复制')
  }
}

async function openFolder(): Promise<void> {
  await window.api.app.openLogDirectory()
}

onMounted(async () => {
  await load()
  timer = window.setInterval(() => {
    if (auto.value) void load()
  }, 3000)
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h2>运行日志</h2>
        <p class="hint mono path" :title="file">{{ file || '（暂无日志文件）' }}</p>
      </div>
      <div class="head-actions">
        <el-input v-model="keyword" placeholder="过滤关键字" clearable size="small" style="width: 180px" />
        <el-checkbox v-model="onlyError" size="small">只看警告/错误</el-checkbox>
        <el-checkbox v-model="auto" size="small">自动刷新</el-checkbox>
        <el-button size="small" @click="load" :loading="loading"><el-icon><Refresh /></el-icon>刷新</el-button>
        <el-button size="small" @click="copyAll"><el-icon><Document /></el-icon>复制</el-button>
        <el-button size="small" @click="openFolder"><el-icon><FolderOpened /></el-icon>打开目录</el-button>
      </div>
    </header>

    <section class="panel log-wrap">
      <div v-if="!rows.length" class="empty">暂无日志</div>
      <div v-for="(l, i) in rows" :key="i" class="log-line" :class="levelOf(l).toLowerCase()">{{ l }}</div>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
}
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  flex: 0 0 auto;
}
.page-head h2 {
  margin: 0 0 2px;
  font-size: 18px;
}
.path {
  color: var(--ink-4);
  font-size: 12px;
  max-width: 560px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.head-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.log-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px;
  font-family: var(--font-mono, Consolas, monospace);
  font-size: 12px;
  line-height: 1.55;
}
.log-line {
  white-space: pre-wrap;
  word-break: break-all;
  padding: 1px 0;
  border-bottom: 1px dashed var(--line);
  color: var(--ink-2);
}
.log-line.warn {
  color: #b8791f;
}
.log-line.error {
  color: var(--zhu);
  font-weight: 600;
}
.log-line.debug {
  color: var(--ink-4);
}
.empty {
  padding: 30px;
  text-align: center;
  color: var(--ink-3);
}
</style>
