<script setup lang="ts">
/**
 * 视频号捕获。
 *
 * 原版这块走的是「自签根证书 + 接管系统代理」的 MITM，能直接解出直播流地址，
 * 但整机 HTTPS 都会经过它（含网银、聊天）。本项目换成合规做法：
 * 屏幕/窗口捕获 + 系统音频回环，用 ffmpeg 的 gdigrab + dshow 录制。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { CaptureConfig, CaptureSource } from '@shared/types'
import { state, refreshHudi, refreshStats, plain } from '../store'
import { formatBytes } from '../format'

const sources = ref<CaptureSource[]>([])
const devices = ref<string[]>([])
const cfg = ref<CaptureConfig | null>(null)
const loadingSources = ref(false)
const starting = ref(false)

const recording = computed(() => !!state.hudi?.recording)
const selected = computed(() => sources.value.find((s) => s.id === cfg.value?.sourceId) ?? null)

const ffReady = computed(() => state.hudi?.ffmpeg.source !== 'none')

async function loadSources(): Promise<void> {
  loadingSources.value = true
  try {
    sources.value = await window.api.hudi.sources()
  } catch (e: unknown) {
    ElMessage.error(`列举窗口失败：${(e as Error)?.message ?? e}`)
  } finally {
    loadingSources.value = false
  }
}

async function loadDevices(): Promise<void> {
  try {
    devices.value = await window.api.hudi.audioDevices()
  } catch {
    devices.value = []
  }
}

function pickSource(s: CaptureSource): void {
  if (!cfg.value) return
  cfg.value.sourceId = s.id
  cfg.value.sourceName = s.name
  cfg.value.mode = s.mode
  void save()
}

async function save(): Promise<void> {
  if (!cfg.value) return
  // cfg 是 ref，直接传 IPC 会报 "An object could not be cloned."
  cfg.value = await window.api.hudi.setConfig(plain(cfg.value))
}

async function start(): Promise<void> {
  if (!ffReady.value) {
    ElMessage.error('未找到 ffmpeg，无法捕获。请先在「设置」里指定 ffmpeg 路径。')
    return
  }
  if (!cfg.value?.sourceName) {
    ElMessage.warning('请先在下方选择一个窗口或屏幕')
    return
  }
  starting.value = true
  try {
    const r = await window.api.hudi.start(plain(cfg.value))
    await refreshHudi()
    await refreshStats()
    ElMessage.success(`开始捕获：${r.file}`)
  } catch (e: unknown) {
    ElMessage.error(`捕获失败：${(e as Error)?.message ?? e}`)
  } finally {
    starting.value = false
  }
}

async function stop(): Promise<void> {
  try {
    await ElMessageBox.confirm('停止捕获并保存当前文件？', '停止捕获', {
      confirmButtonText: '停止',
      cancelButtonText: '继续录制'
    })
    await window.api.hudi.stop()
    await refreshHudi()
    ElMessage.info('已停止捕获')
  } catch {
    /* 取消 */
  }
}

async function locateOutput(): Promise<void> {
  const p = state.hudi?.taskId
  if (p) await window.api.app.showInFolder(p)
}

async function pickDir(): Promise<void> {
  const d = await window.api.config.selectDirectory('选择捕获文件保存目录')
  if (d && cfg.value) {
    cfg.value.saveDir = d
    await save()
  }
}

async function load(): Promise<void> {
  await refreshHudi()
  cfg.value = { ...(state.hudi?.config ?? state.config!.capture) }
  await Promise.all([loadSources(), loadDevices()])
}

let off: (() => void) | null = null

onMounted(async () => {
  await load()
  off = window.api.on.hudiStatus((s) => {
    state.hudi = s
    if (s.error) ElMessage.error(`捕获异常：${s.error}`)
  })
})

onUnmounted(() => {
  off?.()
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h2>视频号捕获</h2>
        <p class="hint">
          微信视频号的直播没有公开接口，这里用「窗口/屏幕捕获 + 系统音频」录制，
          画质取决于窗口大小；不安装证书、不接管代理、不改 hosts。
        </p>
      </div>
      <div class="head-actions">
        <el-button :loading="loadingSources" @click="loadSources">
          <el-icon><Refresh /></el-icon>刷新窗口列表
        </el-button>
        <el-button v-if="!recording" type="primary" :loading="starting" @click="start">
          <el-icon><VideoPlay /></el-icon>开始捕获
        </el-button>
        <el-button v-else type="danger" @click="stop"><el-icon><VideoPause /></el-icon>停止捕获</el-button>
      </div>
    </header>

    <el-alert v-if="!ffReady" type="error" :closable="false" show-icon style="margin-bottom: 10px">
      未找到 ffmpeg，捕获与录制都不可用。请到「设置 → 通用」指定 ffmpeg.exe 路径。
    </el-alert>

    <section v-if="recording" class="panel rec-bar">
      <span class="pill recording"><i class="dot blink" :style="{ background: 'currentColor' }" />捕获中</span>
      <span class="mono file" :title="state.hudi?.taskId">{{ state.hudi?.taskId }}</span>
      <span class="hint">窗口切换或最小化不影响录制；如需停止请点右上角「停止捕获」。</span>
    </section>

    <div class="grid">
      <!-- 源列表 -->
      <section class="panel src-panel">
        <div class="panel-head">
          <span class="panel-title">可捕获的窗口 / 屏幕</span>
          <span class="hint">共 {{ sources.length }} 个</span>
        </div>
        <div v-if="!sources.length" class="empty">没有列举到窗口</div>
        <div v-else class="src-grid">
          <button
            v-for="s in sources"
            :key="s.id"
            class="src"
            :class="{ active: s.id === cfg?.sourceId }"
            :title="s.name"
            @click="pickSource(s)"
          >
            <img v-if="s.thumbnail" :src="s.thumbnail" alt="" />
            <div v-else class="no-thumb"><el-icon><Monitor /></el-icon></div>
            <div class="src-name">
              <el-icon class="mini"><component :is="s.mode === 'screen' ? 'Monitor' : 'Grid'" /></el-icon>
              {{ s.name }}
            </div>
          </button>
        </div>
      </section>

      <!-- 参数 -->
      <section class="panel param-panel">
        <div class="panel-head"><span class="panel-title">捕获参数</span></div>
        <el-form v-if="cfg" label-width="82px" size="default">
          <el-form-item label="模式">
            <el-radio-group v-model="cfg.mode" @change="save">
              <el-radio-button value="window">窗口</el-radio-button>
              <el-radio-button value="screen">整屏</el-radio-button>
            </el-radio-group>
          </el-form-item>

          <el-form-item label="目标">
            <el-input :model-value="cfg.sourceName || '未选择'" readonly />
          </el-form-item>

          <el-form-item label="音频设备">
            <el-select v-model="cfg.audioDevice" clearable placeholder="不录声音" style="width: 100%" @change="save">
              <el-option v-for="d in devices" :key="d" :label="d" :value="d" />
            </el-select>
          </el-form-item>

          <el-form-item label="帧率">
            <el-select v-model="cfg.fps" style="width: 120px" @change="save">
              <el-option :value="15" label="15 fps" />
              <el-option :value="24" label="24 fps" />
              <el-option :value="30" label="30 fps" />
              <el-option :value="60" label="60 fps" />
            </el-select>
          </el-form-item>

          <el-form-item label="画质">
            <el-select v-model="cfg.quality" style="width: 120px" @change="save">
              <el-option v-for="q in state.meta?.qualities ?? []" :key="q" :label="q" :value="q" />
            </el-select>
          </el-form-item>

          <el-form-item label="时长上限">
            <el-input-number v-model="cfg.maxMinutes" :min="0" :max="1440" :step="10" @change="save" />
            <span class="hint" style="margin-left: 8px">分钟，0 = 不限</span>
          </el-form-item>

          <el-form-item label="保存目录">
            <div class="with-btn">
              <el-input v-model="cfg.saveDir" :placeholder="state.config?.outputDir" />
              <el-button @click="pickDir">选择</el-button>
            </div>
          </el-form-item>

          <el-form-item label="名称">
            <el-input v-model="cfg.name" placeholder="用于文件名，例如：某场直播" @change="save" />
          </el-form-item>
        </el-form>

        <div class="tips">
          <p class="hint">
            · 录制前把视频号直播窗口<b>保持在屏幕上可见</b>（被完全遮挡的部分录不到内容）。<br />
            · 想只录画面区域，建议用「窗口」模式，比整屏再裁剪更清晰。<br />
            · 音频需要在「声音设置 → 录制」里启用「立体声混音」，否则下拉里选不到设备。
          </p>
        </div>
      </section>
    </div>

    <section class="panel last" v-if="state.hudi?.taskId">
      <span class="panel-title">当前 / 最近一次输出</span>
      <span class="mono path">{{ state.hudi.taskId }}</span>
      <el-button link @click="locateOutput">在文件夹中定位</el-button>
      <span v-if="state.hudi.error" class="hint bad">{{ state.hudi.error }}</span>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 10px;
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
.head-actions {
  display: flex;
  gap: 6px;
}

.rec-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  flex: 0 0 auto;
}
.rec-bar .file {
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 46%;
}

.grid {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(320px, 1fr);
  gap: 12px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.src-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 12px 14px;
}
.src-grid {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
  align-content: start;
}
.src {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--paper-2);
  padding: 0;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 0.12s, box-shadow 0.12s;
  font-family: var(--font-ui);
}
.src:hover {
  border-color: var(--line-strong);
}
.src.active {
  border-color: var(--zhu);
  box-shadow: 0 0 0 2px var(--zhu-soft);
}
.src img {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  background: #000;
}
.no-thumb {
  width: 100%;
  aspect-ratio: 16 / 9;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--paper-3);
  color: var(--ink-4);
  font-size: 20px;
}
.src-name {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  font-size: 12.5px;
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mini {
  font-size: 13px;
  color: var(--ink-4);
  flex: 0 0 auto;
}

.param-panel {
  padding: 12px 14px;
  overflow: auto;
}
.with-btn {
  display: flex;
  gap: 6px;
  width: 100%;
}
.tips {
  border-top: 1px dashed var(--line);
  padding-top: 10px;
  margin-top: 4px;
}
.tips p {
  margin: 0;
  line-height: 1.9;
}

.last {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  flex: 0 0 auto;
}
.last .path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-2);
}
.bad {
  color: var(--zhu);
}
</style>
