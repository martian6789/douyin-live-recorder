<script setup lang="ts">
/**
 * 语音转写（本地 FunASR / Paraformer）。
 *
 * 与原版一致：音频不出本机。因此界面第一屏是「环境体检」，
 * 按体检结果给出可点的修复动作（装依赖 / 下模型），而不是让用户自己猜。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { TranscribeSettings } from '@shared/types'
import type { TranscribeScanItem } from '@shared/api'
import { state, refreshHistory, plain } from '../store'
import { formatBytes } from '../format'

const env = ref(state.transcribeEnv)
const settings = ref<TranscribeSettings | null>(null)
const items = ref<(TranscribeScanItem & { checked: boolean; hasSubtitle?: boolean })[]>([])
const scanning = ref(false)
const starting = ref(false)
const installing = ref(false)
const downloading = ref(false)
const installLog = ref('')
const progress = ref<{ done: number; total: number; current?: string; message?: string } | null>(null)

const checkedItems = computed(() => items.value.filter((i) => i.checked))
const totalBytes = computed(() => items.value.reduce((a, b) => a + b.sizeBytes, 0))

async function loadEnv(): Promise<void> {
  env.value = await window.api.transcribe.checkEnv()
  state.transcribeEnv = env.value
  settings.value = await window.api.transcribe.getSettings()
}

async function scanDir(): Promise<void> {
  scanning.value = true
  try {
    const list = await window.api.transcribe.scan(state.config?.outputDir)
    items.value = list.map((i) => ({ ...i, checked: !i.hasSubtitle }))
    ElMessage.success(`扫描到 ${list.length} 个视频`)
  } finally {
    scanning.value = false
  }
}

async function pickFiles(): Promise<void> {
  const files = await window.api.transcribe.selectFiles()
  if (!files.length) return
  const exist = new Set(items.value.map((i) => i.file))
  for (const f of files) {
    if (exist.has(f)) continue
    items.value.push({ file: f, name: f.split(/[\\/]/).pop() ?? f, sizeBytes: 0, checked: true })
  }
}

async function pickFolder(): Promise<void> {
  const dir = await window.api.transcribe.selectFolder()
  if (!dir) return
  const list = await window.api.transcribe.scan(dir)
  items.value = list.map((i) => ({ ...i, checked: !i.hasSubtitle }))
}

function toggleAll(v: boolean): void {
  items.value.forEach((i) => (i.checked = v))
}

async function saveSettings(): Promise<void> {
  if (!settings.value) return
  // settings 是 ref，直接传 IPC 会报 "An object could not be cloned."
  settings.value = await window.api.transcribe.saveSettings(plain(settings.value))
  ElMessage.success('转写设置已保存')
}

async function pickModelRoot(): Promise<void> {
  const d = await window.api.transcribe.selectModelRoot()
  if (d && settings.value) {
    settings.value.modelRoot = d
    await saveSettings()
    await loadEnv()
  }
}

async function installDeps(): Promise<void> {
  installing.value = true
  installLog.value = ''
  try {
    await window.api.transcribe.installDeps()
    ElMessage.info('已开始安装依赖，过程输出见下方日志')
  } catch (e: unknown) {
    ElMessage.error(`安装失败：${(e as Error)?.message ?? e}`)
    installing.value = false
  }
}

async function downloadModels(): Promise<void> {
  downloading.value = true
  installLog.value = ''
  try {
    await window.api.transcribe.downloadModels()
    ElMessage.info('已开始下载模型，过程输出见下方日志')
  } catch (e: unknown) {
    ElMessage.error(`下载失败：${(e as Error)?.message ?? e}`)
    downloading.value = false
  }
}

async function startBatch(): Promise<void> {
  const files = checkedItems.value
  if (!files.length) {
    ElMessage.warning('请先勾选要转写的文件')
    return
  }
  starting.value = true
  progress.value = { done: 0, total: files.length }
  try {
    const jobs = await window.api.transcribe.startBatch(
      files.map((f) => ({ file: f.file, name: f.name, sizeBytes: f.sizeBytes }))
    )
    const ok = jobs.filter((j) => j.status === 'done').length
    const bad = jobs.filter((j) => j.status === 'error')
    if (bad.length) ElMessage.warning(`完成 ${ok} 个，失败 ${bad.length} 个：${bad[0]?.error ?? ''}`)
    else ElMessage.success(`全部完成，共 ${ok} 个`)
    await scanDir()
    await refreshHistory()
  } catch (e: unknown) {
    ElMessage.error(`转写失败：${(e as Error)?.message ?? e}`)
  } finally {
    starting.value = false
    progress.value = null
  }
}

async function stopAll(): Promise<void> {
  await window.api.transcribe.stop()
  ElMessage.info('已请求停止')
}

async function deleteOutputs(item: TranscribeScanItem): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除「${item.name}」的字幕产物？（视频本身不动）`, '删除字幕', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
    const removed = await window.api.transcribe.deleteOutputs(item.file)
    ElMessage.success(removed.length ? `已删除 ${removed.length} 个字幕文件` : '没有找到字幕产物')
    await scanDir()
  } catch {
    /* 取消 */
  }
}

let offProgress: (() => void) | null = null
let offInstall: (() => void) | null = null

onMounted(async () => {
  await loadEnv()
  offProgress = window.api.on.transcribeProgress((p: unknown) => {
    const q = p as { done?: number; total?: number; current?: string; message?: string }
    if (q.total != null) progress.value = { done: q.done ?? 0, total: q.total, current: q.current, message: q.message }
  })
  offInstall = window.api.on.transcribeLocalInstall((p: unknown) => {
    const q = p as { status?: string; message?: string }
    installLog.value = `${installLog.value}\n[${q.status ?? ''}] ${q.message ?? ''}`.trim().slice(-4000)
    if (q.status === 'success' || q.status === 'error') {
      installing.value = false
      downloading.value = false
      void loadEnv()
    }
  })
  await scanDir()
})

onUnmounted(() => {
  offProgress?.()
  offInstall?.()
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h2>语音转写</h2>
        <p class="hint">本地 FunASR / Paraformer，音频不出本机；支持 txt / srt / vtt / json，可把字幕烧进视频。</p>
      </div>
      <div class="head-actions">
        <el-button :loading="installing" @click="installDeps"><el-icon><Download /></el-icon>安装依赖</el-button>
        <el-button :loading="downloading" @click="downloadModels"><el-icon><Box /></el-icon>下载模型</el-button>
        <el-button @click="loadEnv"><el-icon><Refresh /></el-icon>重新体检</el-button>
      </div>
    </header>

    <!-- 环境体检 -->
    <section class="panel env">
      <div class="env-head">
        <span class="panel-title">环境体检</span>
        <span v-if="env?.hint" class="hint">{{ env.hint }}</span>
      </div>
      <div class="env-grid">
        <div class="env-item">
          <el-icon :class="env?.pythonFound ? 'ok' : 'bad'">
            <component :is="env?.pythonFound ? 'CircleCheckFilled' : 'CircleCloseFilled'" />
          </el-icon>
          <div>
            <div class="t">Python</div>
            <div class="d mono">{{ env?.pythonPath || '未找到' }} {{ env?.pythonVersion ? `(${env.pythonVersion})` : '' }}</div>
          </div>
        </div>
        <div class="env-item">
          <el-icon :class="env?.funasrInstalled ? 'ok' : 'bad'">
            <component :is="env?.funasrInstalled ? 'CircleCheckFilled' : 'CircleCloseFilled'" />
          </el-icon>
          <div>
            <div class="t">FunASR</div>
            <div class="d">{{ env?.funasrInstalled ? '已安装' : '未安装，点右上角「安装依赖」' }}</div>
          </div>
        </div>
        <div class="env-item">
          <el-icon :class="env?.modelFound ? 'ok' : 'bad'">
            <component :is="env?.modelFound ? 'CircleCheckFilled' : 'CircleCloseFilled'" />
          </el-icon>
          <div>
            <div class="t">模型</div>
            <div class="d">
              {{ env?.modelFound ? `已就绪（${env.models.length} 个）` : '未找到，点右上角「下载模型」' }}
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 设置 -->
    <section class="panel set" v-if="settings">
      <div class="env-head"><span class="panel-title">转写设置</span></div>
      <div class="set-grid">
        <label>格式</label>
        <el-select v-model="settings.format" style="width: 130px">
          <el-option label="SRT 字幕" value="srt" />
          <el-option label="纯文本 TXT" value="txt" />
          <el-option label="VTT 字幕" value="vtt" />
          <el-option label="JSON 详细" value="json" />
        </el-select>

        <label>语言</label>
        <el-select v-model="settings.language" style="width: 130px">
          <el-option label="中文" value="zh" />
          <el-option label="英文" value="en" />
          <el-option label="中英混合" value="zh-en" />
        </el-select>

        <label>模型</label>
        <el-select v-model="settings.model" clearable placeholder="默认模型" style="width: 240px">
          <el-option v-for="m in env?.models ?? []" :key="m" :label="m" :value="m" />
        </el-select>

        <label>模型目录</label>
        <div class="with-btn">
          <el-input v-model="settings.modelRoot" placeholder="留空自动探测" />
          <el-button @click="pickModelRoot">选择</el-button>
        </div>

        <label>烧字幕</label>
        <el-switch v-model="settings.burnIn" />

        <div />
        <el-button type="primary" plain @click="saveSettings">保存设置</el-button>
      </div>
    </section>

    <!-- 文件队列 -->
    <section class="panel queue">
      <div class="env-head">
        <span class="panel-title">转写队列</span>
        <div class="q-actions">
          <span class="hint">共 {{ items.length }} 个 · {{ formatBytes(totalBytes) }}</span>
          <el-button size="small" @click="toggleAll(true)">全选</el-button>
          <el-button size="small" @click="toggleAll(false)">全不选</el-button>
          <el-button size="small" @click="scanDir" :loading="scanning">扫描输出目录</el-button>
          <el-button size="small" @click="pickFolder">选择目录</el-button>
          <el-button size="small" @click="pickFiles">选择文件</el-button>
        </div>
      </div>

      <div v-if="progress" class="progress">
        <el-progress
          :percentage="progress.total ? Math.round((progress.done / progress.total) * 100) : 0"
          :stroke-width="10"
        />
        <span class="hint">
          {{ progress.done }} / {{ progress.total }}
          <template v-if="progress.current"> · 当前：{{ progress.current }}</template>
          <template v-if="progress.message"> · {{ progress.message }}</template>
        </span>
      </div>

      <div class="q-list">
        <el-table :data="items" size="small" height="100%" empty-text="队列为空，点上方按钮加入文件">
          <el-table-column width="42">
            <template #default="{ row }"><el-checkbox v-model="row.checked" /></template>
          </el-table-column>
          <el-table-column label="文件" min-width="260">
            <template #default="{ row }">
              <div class="fname" :title="row.file">{{ row.name }}</div>
              <div class="fpath mono" :title="row.file">{{ row.file }}</div>
            </template>
          </el-table-column>
          <el-table-column label="大小" width="94">
            <template #default="{ row }">
              <span class="mono">{{ row.sizeBytes ? formatBytes(row.sizeBytes) : '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="字幕" width="90">
            <template #default="{ row }">
              <span v-if="row.hasSubtitle" class="pill">已有</span>
              <span v-else class="hint">无</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110" fixed="right">
            <template #default="{ row }">
              <el-button size="small" type="danger" link @click="deleteOutputs(row)">删字幕</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <div class="q-foot">
        <el-button
          type="primary"
          :loading="starting"
          :disabled="!checkedItems.length"
          @click="startBatch"
        >
          <el-icon><VideoPlay /></el-icon>开始转写（{{ checkedItems.length }}）
        </el-button>
        <el-button :disabled="!starting" @click="stopAll"><el-icon><VideoPause /></el-icon>停止</el-button>
        <span class="hint">首次运行需要先把模型下载到本地，之后可以完全离线使用。</span>
      </div>

      <pre v-if="installLog" class="install-log mono">{{ installLog }}</pre>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 10px;
}
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
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

.env,
.set {
  flex: 0 0 auto;
  padding: 12px 14px;
}
.env-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.env-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.env-item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px 10px;
  background: var(--paper-2);
  border-radius: var(--radius-sm);
}
.env-item .t {
  font-weight: 600;
  font-size: 13.5px;
}
.env-item .d {
  color: var(--ink-3);
  font-size: 12.5px;
  word-break: break-all;
}
.ok {
  color: var(--song);
  margin-top: 2px;
}
.bad {
  color: var(--zhu);
  margin-top: 2px;
}

.set-grid {
  display: grid;
  grid-template-columns: 80px auto 80px auto;
  gap: 8px 10px;
  align-items: center;
}
.set-grid label {
  color: var(--ink-3);
  font-size: 13px;
  text-align: right;
}
.with-btn {
  display: flex;
  gap: 6px;
}

.queue {
  flex: 1 1 auto;
  min-height: 260px;
  display: flex;
  flex-direction: column;
  padding: 12px 14px;
}
.q-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.q-list {
  flex: 1 1 auto;
  min-height: 0;
}
.q-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 10px;
}
.progress {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
}
.progress :deep(.el-progress) {
  flex: 1 1 auto;
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

.install-log {
  max-height: 120px;
  overflow: auto;
  background: var(--paper-3);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  margin: 8px 0 0;
  color: var(--ink-2);
  white-space: pre-wrap;
}
</style>
