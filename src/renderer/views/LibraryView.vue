<script setup lang="ts">
/**
 * 录像库：把输出目录扫成可检索清单。
 * 扫描是只读的；删除走系统回收站（可恢复），并会连带清理同名的弹幕/字幕文件。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { RecordFile } from '@shared/types'
import { state, platformColor, platformName } from '../store'
import { formatBytes, formatTime, fromNow } from '../format'

const files = ref<RecordFile[]>([])
const summary = ref({ count: 0, totalBytes: 0, todayCount: 0, todayBytes: 0, withDanmaku: 0, withSubtitle: 0 })
const dir = ref('')
const keyword = ref('')
const loading = ref(false)
const selected = ref<RecordFile[]>([])

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return files.value
  return files.value.filter(
    (f) =>
      f.name.toLowerCase().includes(kw) ||
      (f.streamerName ?? '').toLowerCase().includes(kw) ||
      f.path.toLowerCase().includes(kw)
  )
})

async function scan(): Promise<void> {
  loading.value = true
  try {
    const r = await window.api.library.scan({ dir: dir.value || undefined, recursive: true })
    files.value = r.files
    summary.value = r.summary
  } catch (e: unknown) {
    ElMessage.error(`扫描失败：${(e as Error)?.message ?? e}`)
  } finally {
    loading.value = false
  }
}

async function pickDir(): Promise<void> {
  const d = await window.api.config.selectDirectory('选择要扫描的目录')
  if (d) {
    dir.value = d
    await scan()
  }
}

async function openCurrentDir(): Promise<void> {
  const d = dir.value || state.config?.outputDir
  if (d) await window.api.library.openDirectory(d)
}

async function openFile(f: RecordFile): Promise<void> {
  const ok = await window.api.library.openFile(f.path)
  if (!ok) ElMessage.error('打开失败，文件可能已被移动')
}

async function showInFolder(f: RecordFile): Promise<void> {
  await window.api.app.showInFolder(f.path)
}

async function remove(rows: RecordFile[]): Promise<void> {
  if (!rows.length) return
  try {
    await ElMessageBox.confirm(
      `将把 ${rows.length} 个文件移入回收站（连同同名的弹幕/字幕文件），可从回收站恢复。`,
      '删除确认',
      { confirmButtonText: '移入回收站', cancelButtonText: '取消', type: 'warning' }
    )
    const r = await window.api.library.removeFiles(rows.map((x) => x.path), true)
    ElMessage.success(`已删除 ${r.removed} 个文件${r.failed.length ? `，失败 ${r.failed.length} 个` : ''}`)
    await scan()
  } catch {
    /* 取消 */
  }
}

function onSelectionChange(rows: RecordFile[]): void {
  selected.value = rows
}

onMounted(() => {
  dir.value = state.config?.outputDir ?? ''
  void scan()
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h2>录像库</h2>
        <p class="hint">
          {{ summary.count }} 个文件 · 合计 {{ formatBytes(summary.totalBytes) }} ·
          今日 {{ summary.todayCount }} 个 / {{ formatBytes(summary.todayBytes) }} ·
          带弹幕 {{ summary.withDanmaku }} · 带字幕 {{ summary.withSubtitle }}
        </p>
      </div>
      <div class="head-actions">
        <el-button @click="pickDir"><el-icon><FolderOpened /></el-icon>选择目录</el-button>
        <el-button type="primary" :loading="loading" @click="scan">
          <el-icon><Refresh /></el-icon>重新扫描
        </el-button>
      </div>
    </header>

    <section class="panel filter-bar">
      <span class="dir mono" :title="dir || state.config?.outputDir">{{ dir || state.config?.outputDir }}</span>
      <el-input v-model="keyword" placeholder="按文件名 / 主播筛选" clearable style="width: 240px" />
      <el-button
        type="danger"
        plain
        :disabled="!selected.length"
        @click="remove(selected)"
      >
        <el-icon><Delete /></el-icon>删除选中（{{ selected.length }}）
      </el-button>
      <el-button link @click="openCurrentDir">在资源管理器中打开</el-button>
      <span class="hint" style="margin-left: auto">显示 {{ filtered.length }} / {{ files.length }}</span>
    </section>

    <section class="panel table-wrap">
      <el-table
        :data="filtered"
        size="small"
        height="100%"
        empty-text="目录下没有视频文件"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="42" />

        <el-table-column label="文件" min-width="240">
          <template #default="{ row }">
            <div class="fname" :title="row.path">{{ row.name }}</div>
            <div class="fpath mono" :title="row.dir">{{ row.dir }}</div>
          </template>
        </el-table-column>

        <el-table-column label="来源" width="150">
          <template #default="{ row }">
            <span class="plat">
              <i v-if="row.platform" class="dot" :style="{ background: platformColor(row.platform) }" />
              {{ row.platform ? platformName(row.platform) : '—' }}
              <span v-if="row.streamerName" class="sn">{{ row.streamerName }}</span>
            </span>
          </template>
        </el-table-column>

        <el-table-column label="大小" width="94">
          <template #default="{ row }"><span class="mono">{{ formatBytes(row.sizeBytes) }}</span></template>
        </el-table-column>

        <el-table-column label="伴随文件" width="120">
          <template #default="{ row }">
            <span v-if="row.danmakuFile" class="pill" title="已归档弹幕">弹幕</span>
            <span v-if="row.subFiles?.length" class="pill" title="已生成字幕">字幕</span>
            <span v-if="!row.danmakuFile && !row.subFiles?.length" class="hint">—</span>
          </template>
        </el-table-column>

        <el-table-column label="修改时间" width="150">
          <template #default="{ row }">
            <div>{{ formatTime(row.mtime) }}</div>
            <div class="hint tiny">{{ fromNow(row.mtime) }}</div>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" plain @click="openFile(row)">播放</el-button>
            <el-button size="small" @click="showInFolder(row)">定位</el-button>
            <el-button size="small" type="danger" link @click="remove([row])">删除</el-button>
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

.filter-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  margin-bottom: 10px;
  flex: 0 0 auto;
}
.dir {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
}

.table-wrap {
  flex: 1 1 auto;
  min-height: 0;
  padding: 4px;
  overflow: hidden;
}

.fname {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fpath {
  color: var(--ink-4);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.sn {
  color: var(--ink-3);
}
.hint.tiny {
  font-size: 11.5px;
}
</style>
