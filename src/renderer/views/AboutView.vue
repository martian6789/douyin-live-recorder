<script setup lang="ts">
/** 关于：版本、环境、数据落点，以及与原始软件的关键差异说明。 */
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { state, refreshSystem } from '../store'

const api = window.api
const checking = ref(false)
const update = ref<{ current: string; latest: string; hasUpdate: boolean; url?: string; notes?: string; error?: string } | null>(null)

async function checkUpdate(): Promise<void> {
  checking.value = true
  try {
    update.value = await window.api.app.checkUpdate()
    if (update.value.hasUpdate) ElMessage.success(`发现新版本 ${update.value.latest}`)
    else if (update.value.error) ElMessage.warning(update.value.error)
    else ElMessage.info('当前已是最新版本')
  } finally {
    checking.value = false
  }
}

async function openPath(p?: string): Promise<void> {
  if (!p) return
  await window.api.library.openDirectory(p)
}

onMounted(() => {
  void refreshSystem()
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h2>关于</h2>
        <p class="hint">本地优先的直播录制与复盘工具：无账号、无云端、数据全在自己机器上。</p>
      </div>
      <div class="head-actions">
        <el-button :loading="checking" @click="checkUpdate"><el-icon><Refresh /></el-icon>检查更新</el-button>
        <el-button @click="api.app.openLogDirectory()"><el-icon><Document /></el-icon>打开日志目录</el-button>
      </div>
    </header>

    <div class="grid">
      <section class="panel card">
        <div class="logo-row">
          <div class="logo serif">复</div>
          <div>
            <div class="name serif">直播复盘工具</div>
            <div class="ver mono">
              v{{ state.system?.appVersion ?? '—' }}
              <span v-if="state.system?.portable" class="pill">便携版</span>
            </div>
          </div>
        </div>

        <el-descriptions :column="1" size="small" border style="margin-top: 14px">
          <el-descriptions-item label="Electron">{{ state.system?.electron }}</el-descriptions-item>
          <el-descriptions-item label="Chromium">{{ state.system?.chrome }}</el-descriptions-item>
          <el-descriptions-item label="Node">{{ state.system?.node }}</el-descriptions-item>
          <el-descriptions-item label="平台">{{ state.system?.platform }} / {{ state.system?.arch }}</el-descriptions-item>
          <el-descriptions-item label="ffmpeg">
            {{ state.system?.ffmpeg.version || '未找到' }}
            <span class="hint">（{{ state.system?.ffmpeg.source }}）</span>
          </el-descriptions-item>
        </el-descriptions>
      </section>

      <section class="panel card">
        <div class="panel-title">数据落点</div>
        <ul class="paths">
          <li>
            <span class="k">数据目录</span>
            <span class="v mono" :title="state.system?.dataDir">{{ state.system?.dataDir }}</span>
            <el-button link size="small" @click="openPath(state.system?.dataDir)">打开</el-button>
          </li>
          <li>
            <span class="k">输出目录</span>
            <span class="v mono" :title="state.system?.outputDir">{{ state.system?.outputDir }}</span>
            <el-button link size="small" @click="openPath(state.system?.outputDir)">打开</el-button>
          </li>
          <li>
            <span class="k">日志目录</span>
            <span class="v mono" :title="state.system?.logDir">{{ state.system?.logDir }}</span>
            <el-button link size="small" @click="openPath(state.system?.logDir)">打开</el-button>
          </li>
          <li>
            <span class="k">系统 userData</span>
            <span class="v mono" :title="state.system?.userData">{{ state.system?.userData }}</span>
          </li>
        </ul>
        <p class="hint" style="margin-top: 8px">
          全部配置都是纯 JSON（config.json / streamers.json / tags.json / history.json / credentials.json），
          可直接备份或手工编辑。
        </p>
      </section>
    </div>

    <section class="panel card diff">
      <div class="panel-title">与原始软件的关键差异</div>
      <table class="diff-table">
        <thead>
          <tr>
            <th>能力</th>
            <th>原始软件</th>
            <th>本程序</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>视频号录制</td>
            <td class="bad">自签根证书 + 接管系统代理（MITM），整机 HTTPS 可见</td>
            <td class="ok">窗口/屏幕捕获 + 系统音频回环，不碰证书与代理</td>
          </tr>
          <tr>
            <td>语音转写</td>
            <td>本机 Python 模型</td>
            <td class="ok">同样是本机 FunASR / Paraformer，音频不出本机</td>
          </tr>
          <tr>
            <td>账号体系</td>
            <td>要登录作者服务器，含会员/卡密校验</td>
            <td class="ok">无账号、无联网校验，装完即用</td>
          </tr>
          <tr>
            <td>内置播放预览</td>
            <td>有</td>
            <td class="ok">有（本地中继带 Referer 取流，解决 403）</td>
          </tr>
          <tr>
            <td>数据位置</td>
            <td>%APPDATA%</td>
            <td class="ok">便携版放在 exe 同级 LiveReview-Data/，拷走即走</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel card">
      <div class="panel-title">开源组件</div>
      <ul class="lic">
        <li>Electron / Chromium / Node.js<span class="hint">MIT</span></li>
        <li>Vue 3 · Element Plus · Vite<span class="hint">MIT</span></li>
        <li>FFmpeg<span class="hint">LGPL / GPL</span></li>
        <li>hls.js · mpegts.js（内置播放器）<span class="hint">Apache-2.0</span></li>
        <li>nodemailer（邮件通知，可选）<span class="hint">MIT</span></li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 1000px;
}
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
}
.page-head h2 {
  margin: 0 0 2px;
  font-size: 18px;
}
.head-actions {
  display: flex;
  gap: 6px;
}

.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
  gap: 12px;
}
.card {
  padding: 14px 16px;
}

.logo-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.logo {
  width: 46px;
  height: 46px;
  border-radius: 10px;
  background: var(--zhu);
  color: #fff;
  font-size: 26px;
  line-height: 46px;
  text-align: center;
}
.name {
  font-size: 16px;
}
.ver {
  color: var(--ink-3);
  display: flex;
  align-items: center;
  gap: 6px;
}

.paths {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}
.paths li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px dashed var(--line);
}
.paths li:last-child {
  border-bottom: none;
}
.paths .k {
  flex: 0 0 96px;
  color: var(--ink-3);
  font-size: 13px;
}
.paths .v {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-2);
}

.diff-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 10px;
  font-size: 13.5px;
}
.diff-table th,
.diff-table td {
  text-align: left;
  padding: 7px 10px;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
.diff-table th {
  background: var(--paper-2);
  color: var(--ink-2);
  font-weight: 600;
}
.diff-table td:first-child {
  white-space: nowrap;
  color: var(--ink-2);
  width: 110px;
}
.diff-table .ok {
  color: var(--song);
}
.diff-table .bad {
  color: var(--zhu);
}

.lic {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
}
.lic li {
  display: flex;
  justify-content: space-between;
  padding: 5px 0;
  border-bottom: 1px dashed var(--line);
  color: var(--ink-2);
}
.lic li:last-child {
  border-bottom: none;
}
</style>
