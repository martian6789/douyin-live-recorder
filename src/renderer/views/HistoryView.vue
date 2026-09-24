<script setup lang="ts">
/**
 * 录制历史：录制引擎每次收尾都会往 history.json 追加一条。
 * 与「录像库」的区别：历史是「谁在什么时候录的」这个事件流，库是「盘上现在有什么」。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { HistoryItem } from '@shared/types'
import { state, refreshHistory, platformColor, platformName } from '../store'
import { formatBytes, formatDuration, formatTime, fromNow } from '../format'

const keyword = ref('')
const platform = ref('')

const rows = computed(() => {
  let list = [...state.history].sort((a, b) => b.endedAt - a.endedAt)
  if (platform.value) list = list.filter((h) => h.platform === platform.value)
  const kw = keyword.value.trim().toLowerCase()
  if (kw) {
    list = list.filter(
      (h) =>
        h.streamerName.toLowerCase().includes(kw) ||
        (h.title ?? '').toLowerCase().includes(kw) ||
        h.file.toLowerCase().includes(kw)
    )
  }
  return list
})

const totalBytes = computed(() => rows.value.reduce((a, b) => a + (b.sizeBytes || 0), 0))
const totalMs = computed(() => rows.value.reduce((a, b) => a + (b.durationMs || 0), 0))

async function remove(h: HistoryItem): Promise<void> {
  state.history = await window.api.history.remove(h.id)
}

async function clearAll(): Promise<void> {
  try {
    await ElMessageBox.confirm('只会清空历史记录，磁盘上的视频文件不受影响。', '清空历史', {
      confirmButtonText: '清空',
      cancelButtonText: '取消',
      type: 'warning'
    })
    state.history = await window.api.history.clear()
    ElMessage.success('已清空历史记录')
  } catch {
    /* 取消 */
  }
}

async function openDir(h: HistoryItem): Promise<void> {
  await window.api.library.openDirectory(h.dir)
}

async function openFile(h: HistoryItem): Promise<void> {
  const ok = await window.api.library.openFile(h.file)
  if (!ok) ElMessage.error('文件不存在或已被移动')
}

onMounted(() => {
  void refreshHistory()
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h2>录制历史</h2>
        <p class="hint">
          共 {{ rows.length }} 条 · 合计 {{ formatBytes(totalBytes) }} · 总时长 {{ formatDuration(totalMs) }}
        </p>
      </div>
      <div class="head-actions">
        <el-button @click="refreshHistory"><el-icon><Refresh /></el-icon>刷新</el-button>
        <el-button type="danger" plain :disabled="!state.history.length" @click="clearAll">
          <el-icon><Delete /></el-icon>清空记录
        </el-button>
      </div>
    </header>

    <section class="panel filter-bar">
      <el-select v-model="platform" placeholder="全部平台" clearable style="width: 130px">
        <el-option v-for="p in state.meta?.platformMeta ?? []" :key="p.id" :label="p.name" :value="p.id" />
      </el-select>
      <el-input v-model="keyword" placeholder="按主播 / 标题 / 文件名筛选" clearable style="width: 260px" />
    </section>

    <section class="panel table-wrap">
      <el-table :data="rows" size="small" height="100%" empty-text="还没有录制记录">
        <el-table-column label="主播" min-width="170">
          <template #default="{ row }">
            <span class="plat">
              <i class="dot" :style="{ background: platformColor(row.platform) }" />
              <span class="nm">{{ row.streamerName }}</span>
              <span class="mono rid">{{ row.roomId }}</span>
            </span>
            <div class="title" :title="row.title">{{ row.title || '—' }}</div>
          </template>
        </el-table-column>

        <el-table-column label="平台" width="98">
          <template #default="{ row }">{{ platformName(row.platform) }}</template>
        </el-table-column>

        <el-table-column label="开始" width="150">
          <template #default="{ row }">
            <div>{{ formatTime(row.startedAt) }}</div>
            <div class="hint tiny">{{ fromNow(row.endedAt) }}结束</div>
          </template>
        </el-table-column>

        <el-table-column label="时长" width="86">
          <template #default="{ row }"><span class="mono">{{ formatDuration(row.durationMs) }}</span></template>
        </el-table-column>

        <el-table-column label="大小" width="92">
          <template #default="{ row }"><span class="mono">{{ formatBytes(row.sizeBytes) }}</span></template>
        </el-table-column>

        <el-table-column label="清晰度" width="76">
          <template #default="{ row }">{{ row.quality || '—' }}</template>
        </el-table-column>

        <el-table-column label="产物" width="104">
          <template #default="{ row }">
            <span v-if="row.merged" class="pill">已合并</span>
            <span v-if="row.danmakuFile" class="pill">弹幕</span>
            <span v-if="row.transcribed" class="pill">已转写</span>
          </template>
        </el-table-column>

        <el-table-column label="文件" min-width="160">
          <template #default="{ row }">
            <span class="mono fpath" :title="row.file">{{ row.file.split(/[\\/]/).pop() }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openFile(row)">播放</el-button>
            <el-button size="small" @click="openDir(row)">目录</el-button>
            <el-button size="small" type="danger" link @click="remove(row)">删除</el-button>
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
  gap: 10px;
  padding: 9px 12px;
  margin-bottom: 10px;
  flex: 0 0 auto;
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
.title {
  color: var(--ink-3);
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fpath {
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
  max-width: 100%;
}
.hint.tiny {
  font-size: 11.5px;
}
</style>
