<script setup lang="ts">
/**
 * 合并转码：两个「事后处理」工具，放在一页用 Tab 切换。
 *
 * 合并用 concat demuxer + -c copy（无损、秒级）；转码默认只换容器，勾选重编码才会重新编码。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ConvertItemInfo, ConvertOptionsIO, MergeGroupItem } from '@shared/api'
import { state, plain } from '../store'
import { formatBytes, formatTime } from '../format'

const tab = ref<'merge' | 'convert'>('merge')
const dir = ref('')
const busy = ref(false)

/* --------------------------------------------------------------- 合并 */
const groups = ref<MergeGroupItem[]>([])
const mergeOpt = ref({ deleteSource: false, overwrite: false })
const mergeOut = ref<{ name: string; ok: boolean; error?: string }[]>([])
const autoTasks = ref<{ dir: string; files: string[]; reason: string; createdAt: number }[]>([])

async function scanMerge(): Promise<void> {
  busy.value = true
  try {
    groups.value = (await window.api.merger.scan(dir.value || undefined)) as MergeGroupItem[]
    autoTasks.value = (await window.api.merger.autoTasks()) as typeof autoTasks.value
  } finally {
    busy.value = false
  }
}

async function doMerge(): Promise<void> {
  if (!groups.value.length) return
  try {
    await ElMessageBox.confirm(
      `将合并 ${groups.value.length} 组分段为单文件${mergeOpt.value.deleteSource ? '，并删除原分段' : ''}。`,
      '合并确认',
      { confirmButtonText: '开始合并', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  busy.value = true
  mergeOut.value = []
  try {
    // ref 包装的数组/对象是 Proxy，直接传 IPC 会报 "An object could not be cloned."
    const jobs = await window.api.merger.startBatch(plain(groups.value), plain(mergeOpt.value))
    mergeOut.value = jobs.map((j) => ({
      name: j.file.split(/[\\/]/).pop() ?? j.file,
      ok: j.status === 'done',
      error: j.error
    }))
    const ok = jobs.filter((j) => j.status === 'done').length
    ElMessage.success(`合并完成 ${ok} / ${jobs.length}`)
    await scanMerge()
  } catch (e: unknown) {
    ElMessage.error(`合并失败：${(e as Error)?.message ?? e}`)
  } finally {
    busy.value = false
  }
}

async function clearAuto(): Promise<void> {
  await window.api.merger.clearAutoTasks()
  autoTasks.value = []
}

/* --------------------------------------------------------------- 转码 */
const convertItems = ref<(ConvertItemInfo & { checked: boolean })[]>([])
const convertOpt = ref<ConvertOptionsIO>({
  container: 'mp4',
  reencode: false,
  outDir: '',
  overwrite: false,
  deleteSource: false
})
const convertOut = ref<{ name: string; ok: boolean; error?: string }[]>([])

const checkedCount = computed(() => convertItems.value.filter((i) => i.checked).length)

async function scanConvert(): Promise<void> {
  busy.value = true
  try {
    const list = await window.api.converter.scan(dir.value || undefined)
    convertItems.value = list.map((i) => ({ ...i, checked: true }))
  } finally {
    busy.value = false
  }
}

async function pickOutDir(): Promise<void> {
  const d = await window.api.config.selectDirectory('选择转码输出目录')
  if (d) convertOpt.value.outDir = d
}

async function doConvert(): Promise<void> {
  const items = convertItems.value.filter((i) => i.checked)
  if (!items.length) {
    ElMessage.warning('请先勾选要处理的文件')
    return
  }
  if (!convertOpt.value.reencode && convertOpt.value.container === 'mp4') {
    // 允许，但提醒一句：如果源已经是 mp4，会因同名而跳过
  }
  busy.value = true
  convertOut.value = []
  try {
    const jobs = await window.api.converter.startBatch(plain(items), plain(convertOpt.value))
    convertOut.value = jobs.map((j) => ({
      name: j.file.split(/[\\/]/).pop() ?? j.file,
      ok: j.status === 'done',
      error: j.error
    }))
    const ok = jobs.filter((j) => j.status === 'done').length
    ElMessage.success(`完成 ${ok} / ${jobs.length}`)
    await scanConvert()
  } catch (e: unknown) {
    ElMessage.error(`转码失败：${(e as Error)?.message ?? e}`)
  } finally {
    busy.value = false
  }
}

/* ----------------------------------------------------------- 进度订阅 */
let offMerge: (() => void) | null = null
let offConvert: (() => void) | null = null

onMounted(async () => {
  dir.value = state.config?.outputDir ?? ''
  await Promise.all([scanMerge(), scanConvert()])

  offMerge = window.api.on.mergeProgress((p: unknown) => {
    const q = p as { total?: number; done?: number; current?: string }
    if (q.total != null) state.tasks.merge = { done: q.done ?? 0, total: q.total }
  })
  offConvert = window.api.on.convertProgress((p: unknown) => {
    const q = p as { total?: number; done?: number }
    if (q.total != null) state.tasks.convert = { done: q.done ?? 0, total: q.total }
  })
})

onUnmounted(() => {
  offMerge?.()
  offConvert?.()
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h2>合并转码</h2>
        <p class="hint">
          分段合并用 concat 无损拼接；转码默认只换容器（秒级），勾「重新编码」才会转 H.264/AAC。
        </p>
      </div>
      <div class="head-actions">
        <el-input v-model="dir" :placeholder="state.config?.outputDir" style="width: 300px" />
        <el-button type="primary" :loading="busy" @click="tab === 'merge' ? scanMerge() : scanConvert()">
          <el-icon><Refresh /></el-icon>扫描
        </el-button>
      </div>
    </header>

    <el-tabs v-model="tab" class="panel tabs">
      <!-- ------------------------------------------------------ 合并 -->
      <el-tab-pane label="分段合并" name="merge">
        <div class="opt-bar">
          <el-checkbox v-model="mergeOpt.deleteSource">合并后删除原分段</el-checkbox>
          <el-checkbox v-model="mergeOpt.overwrite">覆盖已存在的合并文件</el-checkbox>
          <el-button type="primary" :loading="busy" :disabled="!groups.length" @click="doMerge">
            开始合并（{{ groups.length }} 组）
          </el-button>
          <span class="hint">合并结果与分段同名（去掉 _001 序号）</span>
        </div>

        <el-table :data="groups" size="small" max-height="300" empty-text="没有发现多分段文件">
          <el-table-column label="输出文件" min-width="260">
            <template #default="{ row }">
              <div class="fname">{{ row.output.split(/[\\/]/).pop() }}</div>
              <div class="fpath mono" :title="row.dir">{{ row.dir }}</div>
            </template>
          </el-table-column>
          <el-table-column label="分段数" width="80">
            <template #default="{ row }">{{ row.files.length }}</template>
          </el-table-column>
          <el-table-column label="合计大小" width="104">
            <template #default="{ row }"><span class="mono">{{ formatBytes(row.totalBytes) }}</span></template>
          </el-table-column>
          <el-table-column label="已存在" width="86">
            <template #default="{ row }">
              <span v-if="row.exists" class="pill">是</span>
              <span v-else class="hint">否</span>
            </template>
          </el-table-column>
        </el-table>

        <div v-if="autoTasks.length" class="auto-tasks">
          <div class="env-head">
            <span class="panel-title">录制结束待合并</span>
            <el-button size="small" @click="clearAuto">清空列表</el-button>
          </div>
          <ul>
            <li v-for="(t, i) in autoTasks" :key="i">
              <span class="mono">{{ t.files.length }} 个分段</span>
              <span class="hint">{{ t.reason }}</span>
              <span class="hint">{{ formatTime(t.createdAt) }}</span>
            </li>
          </ul>
        </div>

        <ul v-if="mergeOut.length" class="result">
          <li v-for="(r, i) in mergeOut" :key="i">
            <el-icon :class="r.ok ? 'ok' : 'bad'">
              <component :is="r.ok ? 'CircleCheckFilled' : 'CircleCloseFilled'" />
            </el-icon>
            <span>{{ r.name }}</span>
            <span v-if="r.error" class="hint">{{ r.error }}</span>
          </li>
        </ul>
      </el-tab-pane>

      <!-- ------------------------------------------------------ 转码 -->
      <el-tab-pane label="批量转码" name="convert">
        <div class="opt-bar">
          <span class="lbl">目标容器</span>
          <el-select v-model="convertOpt.container" style="width: 110px">
            <el-option label="MP4" value="mp4" />
            <el-option label="MKV" value="mkv" />
            <el-option label="TS" value="ts" />
            <el-option label="FLV" value="flv" />
          </el-select>
          <el-checkbox v-model="convertOpt.reencode">重新编码（慢，兼容性最好）</el-checkbox>
          <el-checkbox v-model="convertOpt.overwrite">覆盖已存在</el-checkbox>
          <el-checkbox v-model="convertOpt.deleteSource">完成后删除源文件</el-checkbox>
          <div class="with-btn">
            <el-input v-model="convertOpt.outDir" placeholder="输出目录（留空=原目录）" style="width: 220px" />
            <el-button @click="pickOutDir">选择</el-button>
          </div>
          <el-button type="primary" :loading="busy" :disabled="!checkedCount" @click="doConvert">
            开始转码（{{ checkedCount }}）
          </el-button>
        </div>

        <el-table :data="convertItems" size="small" max-height="360" empty-text="目录下没有视频">
          <el-table-column width="42">
            <template #default="{ row }"><el-checkbox v-model="row.checked" /></template>
          </el-table-column>
          <el-table-column label="文件" min-width="260">
            <template #default="{ row }">
              <div class="fname">{{ row.name }}</div>
              <div class="fpath mono" :title="row.dir">{{ row.dir }}</div>
            </template>
          </el-table-column>
          <el-table-column label="大小" width="104">
            <template #default="{ row }"><span class="mono">{{ formatBytes(row.sizeBytes) }}</span></template>
          </el-table-column>
        </el-table>

        <ul v-if="convertOut.length" class="result">
          <li v-for="(r, i) in convertOut" :key="i">
            <el-icon :class="r.ok ? 'ok' : 'bad'">
              <component :is="r.ok ? 'CircleCheckFilled' : 'CircleCloseFilled'" />
            </el-icon>
            <span>{{ r.name }}</span>
            <span v-if="r.error" class="hint">{{ r.error }}</span>
          </li>
        </ul>
      </el-tab-pane>
    </el-tabs>
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
  gap: 12px;
}
.page-head h2 {
  margin: 0 0 2px;
  font-size: 18px;
}
.head-actions {
  display: flex;
  gap: 6px;
}
.tabs {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 4px 14px 12px;
}
.opt-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 8px 0 12px;
}
.opt-bar .lbl {
  color: var(--ink-3);
  font-size: 13px;
}
.with-btn {
  display: flex;
  gap: 6px;
}
.auto-tasks {
  margin-top: 10px;
}
.auto-tasks ul {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
}
.auto-tasks li {
  display: flex;
  gap: 12px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--line);
}
.result {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
}
.result li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
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
.ok {
  color: var(--song);
}
.bad {
  color: var(--zhu);
}
.env-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
</style>
