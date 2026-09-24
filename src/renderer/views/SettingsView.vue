<script setup lang="ts">
/**
 * 设置：通用 / 命名模板 / 录制并发 / 磁盘看护 / 消息通知 / 平台 Cookie。
 *
 * 编辑策略：整份配置先拷到本地 form，改动后点「保存」统一提交；
 * 少数即时生效项（主题、磁盘）单独走 saveConfig 立即提交。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { AppConfig, CredentialState, PlatformId, TemplateVariable } from '@shared/types'
import { state, refreshDisk, setTheme, refreshSystem, platformColor, platformName, plain } from '../store'
import { formatBytes } from '../format'

const tab = ref('general')
const form = ref<AppConfig | null>(null)
const saving = ref(false)
const dirty = ref(false)

const templateVars = ref<TemplateVariable[]>([])
const tplCheck = ref<{ ok: boolean; unknown: string[]; normalized: string; error?: string } | null>(null)
const tplPreview = ref('')

const credentials = ref<CredentialState[]>([])
const cookieInput = ref<Record<string, string>>({})
const validating = ref('')

function clone(): AppConfig {
  return JSON.parse(JSON.stringify(state.config)) as AppConfig
}

onMounted(async () => {
  form.value = clone()
  templateVars.value = await window.api.config.templateVariables()
  credentials.value = await window.api.credential.all()
  await validateTemplate()
})

watch(
  () => form.value,
  () => {
    dirty.value = true
  },
  { deep: true }
)

async function save(): Promise<void> {
  if (!form.value) return
  saving.value = true
  try {
    // form 是 ref，直接传会被 Vue 代理化，IPC 无法克隆 —— 先转纯对象
    state.config = await window.api.config.set(plain(form.value))
    form.value = clone()
    dirty.value = false
    await Promise.all([refreshDisk(), refreshSystem()])
    ElMessage.success('设置已保存')
  } catch (e: unknown) {
    ElMessage.error(`保存失败：${(e as Error)?.message ?? e}`)
  } finally {
    saving.value = false
  }
}

async function resetAll(): Promise<void> {
  try {
    await ElMessageBox.confirm('将把所有设置恢复为默认值（不影响主播库与录像历史）。', '恢复默认', {
      confirmButtonText: '恢复默认',
      cancelButtonText: '取消',
      type: 'warning'
    })
    state.config = await window.api.config.reset()
    form.value = clone()
    ElMessage.success('已恢复默认设置')
  } catch {
    /* 取消 */
  }
}

/* ------------------------------------------------------------ 通用 */
async function pickOutputDir(): Promise<void> {
  const d = await window.api.config.selectDirectory('选择录像输出目录')
  if (d && form.value) form.value.outputDir = d
}

async function openOutputDir(): Promise<void> {
  if (!form.value?.outputDir) return
  await window.api.library.openDirectory(form.value.outputDir)
}

async function pickFfmpeg(): Promise<void> {
  const d = await window.api.config.selectDirectory('选择包含 ffmpeg.exe 的目录')
  if (!d || !form.value) return
  form.value.ffmpegPath = `${d}\\ffmpeg.exe`
  ElMessage.info('已填入路径，保存后生效')
}

/** Element Plus 的 radio-group 只给 string|number|boolean，这里统一收口转换 */
async function onThemePick(v: unknown): Promise<void> {
  const theme = (v === 'dark' || v === 'system' ? v : 'light') as 'light' | 'dark' | 'system'
  await setTheme(theme)
  if (form.value) form.value.theme = theme
}

async function onAutoStartup(v: unknown): Promise<void> {
  const on = !!v
  if (form.value) form.value.autoStartup = on
  await window.api.app.setAutoStartup(on)
}

async function pickDiskPath(): Promise<void> {
  const d = await window.api.config.selectDirectory('选择监控目录')
  if (d && form.value) form.value.disk.path = d
}

function setEmailTo(v: string): void {
  if (!form.value) return
  form.value.notify.email.to = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/* ------------------------------------------------------------ 模板 */
async function validateTemplate(): Promise<void> {
  if (!form.value) return
  tplCheck.value = await window.api.config.validateTemplate(form.value.template)
  tplPreview.value = await window.api.config.previewTemplate(form.value.template)
}

function insertVar(key: string): void {
  if (!form.value) return
  form.value.template += `{${key}}`
  void validateTemplate()
}

/* -------------------------------------------------------- Cookie */
async function saveCookie(p: PlatformId): Promise<void> {
  const v = cookieInput.value[p]
  if (!v?.trim()) {
    ElMessage.warning('请先粘贴 Cookie')
    return
  }
  await window.api.credential.set(p, v.trim())
  cookieInput.value[p] = ''
  credentials.value = await window.api.credential.all()
  ElMessage.success(`${platformName(p)} Cookie 已保存`)
}

async function clearCookie(p: PlatformId): Promise<void> {
  await window.api.credential.clear(p)
  credentials.value = await window.api.credential.all()
  ElMessage.success('已清除')
}

async function validateCookie(p: PlatformId): Promise<void> {
  validating.value = p
  try {
    const r = await window.api.credential.validate(p)
    credentials.value = await window.api.credential.all()
    ElMessage[r.valid ? 'success' : 'warning'](r.hint ?? (r.valid ? '有效' : '无效'))
  } finally {
    validating.value = ''
  }
}

/* -------------------------------------------------------- 通知 */
const notifying = ref(false)

async function testNotify(): Promise<void> {
  notifying.value = true
  try {
    const r = await window.api.notify.test()
    if (r.ok) ElMessage.success('测试通知已发送')
    else ElMessage.error(r.error ?? '发送失败')
  } finally {
    notifying.value = false
  }
}

/* -------------------------------------------------------- 磁盘 */
async function runDiskCheck(): Promise<void> {
  const r = await window.api.disk.runCheck()
  await refreshDisk()
  ElMessage.info(`剩余 ${formatBytes(r.usage.freeBytes)} / 共 ${formatBytes(r.usage.totalBytes)}`)
}

const usedPercent = computed(() => state.diskUsage?.usedPercent ?? 0)

const enabledChannels = computed(() => {
  const n = form.value?.notify
  if (!n) return 0
  return [n.webhook.enabled, n.wecom.enabled, n.email.enabled].filter(Boolean).length
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h2>设置</h2>
        <p class="hint">
          配置文件与数据都在 <span class="mono">{{ state.system?.dataDir }}</span>
          <template v-if="state.system?.portable">（便携目录，拷走 exe 即拷走数据）</template>
        </p>
      </div>
      <div class="head-actions">
        <el-button @click="resetAll">恢复默认</el-button>
        <el-button type="primary" :loading="saving" :disabled="!dirty" @click="save">
          <el-icon><Check /></el-icon>保存设置
        </el-button>
      </div>
    </header>

    <el-tabs v-model="tab" class="panel tabs">
      <!-- ================================================== 通用 -->
      <el-tab-pane label="通用" name="general">
        <el-form v-if="form" label-width="110px" class="form">
          <el-form-item label="输出目录">
            <div class="with-btn">
              <el-input v-model="form.outputDir" />
              <el-button @click="pickOutputDir">选择</el-button>
              <el-button @click="openOutputDir">打开</el-button>
            </div>
          </el-form-item>

          <el-form-item label="容器格式">
            <el-select v-model="form.container" style="width: 130px">
              <el-option label="MP4（推荐）" value="mp4" />
              <el-option label="TS（断流更稳）" value="ts" />
              <el-option label="MKV" value="mkv" />
              <el-option label="FLV" value="flv" />
            </el-select>
            <span class="hint" style="margin-left: 10px">TS 在断流时容错更好，MP4 更通用</span>
          </el-form-item>

          <el-form-item label="分段">
            <el-input-number v-model="form.segmentMinutes" :min="0" :max="720" :step="10" />
            <span class="hint" style="margin-left: 8px">分钟切一个文件，0 = 不分段</span>
          </el-form-item>

          <el-form-item label="分段体积">
            <el-input-number v-model="form.segmentSizeMB" :min="0" :max="10240" :step="256" />
            <span class="hint" style="margin-left: 8px">MB，0 = 不按体积切</span>
          </el-form-item>

          <el-form-item label="ffmpeg">
            <div class="with-btn">
              <el-input v-model="form.ffmpegPath" placeholder="留空用内置 ffmpeg" />
              <el-button @click="pickFfmpeg">选择目录</el-button>
            </div>
            <div class="hint">
              当前生效：<b>{{ state.system?.ffmpeg.version || '(未找到)' }}</b>
              （来源：{{ state.system?.ffmpeg.source }}）
            </div>
          </el-form-item>

          <el-form-item label="User-Agent">
            <el-input v-model="form.userAgent" />
            <div class="hint">部分平台会校验 UA，一般保持默认即可</div>
          </el-form-item>

          <el-divider content-position="left">外观与行为</el-divider>

          <el-form-item label="主题">
            <el-radio-group :model-value="form.theme" @change="onThemePick">
              <el-radio-button value="light">浅色</el-radio-button>
              <el-radio-button value="dark">深色</el-radio-button>
              <el-radio-button value="system">跟随系统</el-radio-button>
            </el-radio-group>
          </el-form-item>

          <el-form-item label="开机自启">
            <el-switch :model-value="form.autoStartup" @change="onAutoStartup" />
            <span class="hint" style="margin-left: 8px">打包安装后生效</span>
          </el-form-item>

          <el-form-item label="关闭按钮">
            <el-radio-group v-model="form.closeBehavior">
              <el-radio-button value="tray">最小化到托盘</el-radio-button>
              <el-radio-button value="quit">直接退出</el-radio-button>
            </el-radio-group>
          </el-form-item>

          <el-form-item label="最小化到托盘">
            <el-switch v-model="form.minimizeToTray" />
          </el-form-item>

        </el-form>
      </el-tab-pane>

      <!-- ============================================== 命名模板 -->
      <el-tab-pane label="命名模板" name="template">
        <div v-if="form" class="tpl">
          <el-input v-model="form.template" placeholder="{platform}/{name}/{date}/{time}_{title}" @change="validateTemplate" />

          <div class="tpl-row">
            <el-button size="small" @click="validateTemplate"><el-icon><Check /></el-icon>校验</el-button>
            <el-button size="small" @click="form.template = '{platform}/{name}/{date}/{time}_{title}'; validateTemplate()">
              恢复默认模板
            </el-button>
            <span class="hint">用 / 可以建子目录，例如 {platform}/{name}/{date}/</span>
          </div>

          <el-alert v-if="tplCheck && !tplCheck.ok" type="warning" :closable="false" show-icon>
            <template v-if="tplCheck.error">{{ tplCheck.error }}</template>
            <template v-else>未知变量：{{ tplCheck.unknown.join('、') }}（会被原样保留）</template>
          </el-alert>

          <div class="preview">
            <div class="k">预览（示例主播）</div>
            <div class="v mono">{{ tplPreview }}</div>
          </div>

          <div class="vars">
            <div class="k">可用变量（点击插入）</div>
            <div class="var-list">
              <button v-for="v in templateVars" :key="v.key" class="var" @click="insertVar(v.key)">
                <span class="mono">{{ '{' + v.key + '}' }}</span>
                <span class="desc">{{ v.desc }}</span>
                <span class="mono sample">{{ v.sample }}</span>
              </button>
            </div>
          </div>
        </div>
      </el-tab-pane>

      <!-- ============================================== 录制并发 -->
      <el-tab-pane label="录制与并发" name="record">
        <el-form v-if="form" label-width="120px" class="form">
          <el-form-item label="检测间隔">
            <el-input-number v-model="form.checkIntervalSec" :min="10" :max="3600" :step="10" />
            <span class="hint" style="margin-left: 8px">秒；太快容易被平台限流</span>
          </el-form-item>

          <el-form-item label="最大并发">
            <el-input-number v-model="form.maxConcurrent" :min="1" :max="30" />
            <span class="hint" style="margin-left: 8px">同时录制的上限</span>
          </el-form-item>

          <el-form-item label="同平台上限">
            <el-input-number v-model="form.perPlatformLimit" :min="1" :max="20" />
          </el-form-item>

          <el-form-item label="断流重试">
            <el-input-number v-model="form.retryTimes" :min="0" :max="20" />
            <span class="hint" style="margin-left: 8px">次</span>
          </el-form-item>

          <el-form-item label="重连间隔">
            <el-input-number v-model="form.reconnectDelaySec" :min="1" :max="120" />
            <span class="hint" style="margin-left: 8px">秒</span>
          </el-form-item>

          <el-divider content-position="left">自动化</el-divider>

          <el-form-item label="全局自动录制">
            <el-switch v-model="form.autoRecord" />
            <span class="hint" style="margin-left: 8px">
              关闭时，即使主播勾了「自动录制」也不会开录（用于临时全停）
            </span>
          </el-form-item>

          <el-form-item label="保存弹幕">
            <el-switch v-model="form.saveDanmaku" />
          </el-form-item>

          <el-form-item label="导出 ASS">
            <el-switch v-model="form.exportAss" />
            <span class="hint" style="margin-left: 8px">额外生成可直接挂进播放器的 ASS 弹幕</span>
          </el-form-item>

          <el-form-item label="自动合并">
            <el-switch v-model="form.autoMerge" />
            <span class="hint" style="margin-left: 8px">录制结束后，把多分段排队合并</span>
          </el-form-item>

          <el-form-item label="自动转写">
            <el-switch v-model="form.autoTranscribe" />
            <span class="hint" style="margin-left: 8px">录制结束后自动跑一遍本地转写</span>
          </el-form-item>

          <el-divider content-position="left">各平台默认清晰度</el-divider>

          <el-form-item v-for="p in state.meta?.platformMeta ?? []" :key="p.id" :label="p.name">
            <el-select v-model="form.quality[p.id]" style="width: 140px">
              <el-option v-for="q in state.meta?.qualities ?? []" :key="q" :label="q" :value="q" />
            </el-select>
            <span class="dot" :style="{ background: p.color, marginLeft: '10px' }" />
            <span class="hint" style="margin-left: 6px">{{ p.needsCookie ? '建议填 Cookie' : '无需登录' }}</span>
          </el-form-item>
        </el-form>
      </el-tab-pane>

      <!-- ============================================== 磁盘看护 -->
      <el-tab-pane label="磁盘看护" name="disk">
        <el-form v-if="form" label-width="120px" class="form">
          <el-form-item label="启用看护">
            <el-switch v-model="form.disk.enabled" />
          </el-form-item>

          <el-form-item label="剩余阈值">
            <el-input-number v-model="form.disk.minFreeGB" :min="1" :max="1000" :step="5" />
            <span class="hint" style="margin-left: 8px">GB，低于此值触发动作</span>
          </el-form-item>

          <el-form-item label="检查间隔">
            <el-input-number v-model="form.disk.checkIntervalMin" :min="1" :max="1440" :step="5" />
            <span class="hint" style="margin-left: 8px">分钟</span>
          </el-form-item>

          <el-form-item label="触发动作">
            <el-radio-group v-model="form.disk.action">
              <el-radio-button value="notify">仅提醒</el-radio-button>
              <el-radio-button value="stop-record">停止录制</el-radio-button>
              <el-radio-button value="clean-oldest">清理最旧录像</el-radio-button>
            </el-radio-group>
          </el-form-item>

          <el-form-item label="保留天数">
            <el-input-number v-model="form.disk.keepDays" :min="1" :max="365" />
            <span class="hint" style="margin-left: 8px">选择「清理最旧录像」时，删除早于该天数的视频</span>
          </el-form-item>

          <el-form-item label="监控路径">
            <div class="with-btn">
              <el-input v-model="form.disk.path" placeholder="留空则监控输出目录所在盘" />
              <el-button @click="pickDiskPath">选择</el-button>
            </div>
          </el-form-item>

          <el-form-item label="当前状态">
            <div class="disk-now">
              <el-progress
                :percentage="usedPercent"
                :stroke-width="12"
                :status="state.diskUsage?.warning ? 'warning' : undefined"
                style="flex: 1 1 auto"
              />
              <span class="mono">
                {{ state.diskUsage ? `剩余 ${formatBytes(state.diskUsage.freeBytes)}` : '未检测' }}
              </span>
              <el-button size="small" @click="runDiskCheck">立即检测</el-button>
            </div>
          </el-form-item>
        </el-form>
      </el-tab-pane>

      <!-- ============================================== 消息通知 -->
      <el-tab-pane label="消息通知" name="notify">
        <div v-if="form" class="notify">
          <div class="notify-head">
            <span class="hint">已启用 {{ enabledChannels }} 个通道；通知失败不会影响录制。</span>
            <el-button size="small" :loading="notifying" @click="testNotify">
              <el-icon><Bell /></el-icon>发送测试通知
            </el-button>
          </div>

          <el-divider content-position="left">触发事件</el-divider>
          <div class="evt-row">
            <el-checkbox v-model="form.notify.onLiveStart">开播</el-checkbox>
            <el-checkbox v-model="form.notify.onRecordStart">开始录制</el-checkbox>
            <el-checkbox v-model="form.notify.onRecordEnd">录制完成</el-checkbox>
            <el-checkbox v-model="form.notify.onError">异常</el-checkbox>
            <el-checkbox v-model="form.notify.onDiskWarning">磁盘告警</el-checkbox>
          </div>

          <el-divider content-position="left">企业微信机器人</el-divider>
          <el-form label-width="90px" class="form">
            <el-form-item label="启用">
              <el-switch v-model="form.notify.wecom.enabled" />
            </el-form-item>
            <el-form-item label="Webhook">
              <el-input v-model="form.notify.wecom.webhook" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." />
            </el-form-item>
          </el-form>

          <el-divider content-position="left">自定义 Webhook</el-divider>
          <el-form label-width="90px" class="form">
            <el-form-item label="启用">
              <el-switch v-model="form.notify.webhook.enabled" />
            </el-form-item>
            <el-form-item label="地址">
              <el-input v-model="form.notify.webhook.url" placeholder="https://example.com/hook" />
            </el-form-item>
            <el-form-item label="方法">
              <el-select v-model="form.notify.webhook.method" style="width: 120px">
                <el-option label="POST" value="POST" />
                <el-option label="PUT" value="PUT" />
                <el-option label="GET" value="GET" />
              </el-select>
            </el-form-item>
            <el-form-item label="请求体">
              <el-input v-model="form.notify.webhook.bodyTemplate" type="textarea" :rows="3" />
              <div class="hint">
                可用变量：{event} {eventLabel} {name} {platform} {platformName} {title} {roomId} {file}
                {size} {duration} {message} {date} {time}
              </div>
            </el-form-item>
          </el-form>

          <el-divider content-position="left">邮件（需要 nodemailer）</el-divider>
          <el-form label-width="90px" class="form">
            <el-form-item label="启用">
              <el-switch v-model="form.notify.email.enabled" />
            </el-form-item>
            <el-form-item label="SMTP">
              <el-input v-model="form.notify.email.host" placeholder="smtp.qq.com" style="width: 200px" />
              <el-input-number v-model="form.notify.email.port" :min="1" :max="65535" style="margin-left: 8px" />
              <el-checkbox v-model="form.notify.email.secure" style="margin-left: 10px">SSL</el-checkbox>
            </el-form-item>
            <el-form-item label="账号">
              <el-input v-model="form.notify.email.user" placeholder="发件邮箱" />
            </el-form-item>
            <el-form-item label="密码">
              <el-input v-model="form.notify.email.pass" type="password" show-password placeholder="授权码" />
            </el-form-item>
            <el-form-item label="收件人">
              <el-input
                :model-value="form.notify.email.to.join(', ')"
                placeholder="多个用英文逗号分隔"
                @update:model-value="setEmailTo"
              />
            </el-form-item>
          </el-form>
        </div>
      </el-tab-pane>

      <!-- ============================================== Cookie -->
      <el-tab-pane label="平台 Cookie" name="cookie">
        <div class="cookie">
          <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px">
            抖音、快手、B 站的部分接口需要登录态。Cookie 只保存在本机数据目录，不会上传到任何服务器。
            获取方式：浏览器登录后按 F12 → Network → 任意请求 → 复制 Request Headers 里的 Cookie 整行。
          </el-alert>

          <div v-for="c in credentials" :key="c.platform" class="cookie-row">
            <div class="cr-head">
              <i class="dot" :style="{ background: platformColor(c.platform) }" />
              <span class="nm">{{ platformName(c.platform) }}</span>
              <span v-if="c.hasCookie" class="pill" :class="c.valid === false ? 'error' : 'recording'">
                {{ c.valid === false ? '可能失效' : '已保存' }}
              </span>
              <span v-else class="pill offline">未设置</span>
              <span v-if="c.accountName" class="hint">{{ c.accountName }}</span>
              <span class="hint">更新：{{ c.updatedAt ? new Date(c.updatedAt).toLocaleString() : '—' }}</span>
            </div>
            <div class="cr-body">
              <el-input
                v-model="cookieInput[c.platform]"
                type="textarea"
                :rows="2"
                :placeholder="c.hasCookie ? '粘贴新的 Cookie 以覆盖' : '粘贴 Cookie（形如 SESSDATA=xxx; bili_jct=yyy）'"
              />
              <div class="cr-btns">
                <el-button size="small" type="primary" @click="saveCookie(c.platform)">保存</el-button>
                <el-button size="small" :loading="validating === c.platform" @click="validateCookie(c.platform)">
                  校验
                </el-button>
                <el-button size="small" type="danger" plain :disabled="!c.hasCookie" @click="clearCookie(c.platform)">
                  清除
                </el-button>
                <span v-if="c.hint" class="hint">{{ c.hint }}</span>
              </div>
            </div>
          </div>
        </div>
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
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 4px 16px 20px;
}
/* 滚动区放在 el-tabs 内容层：根元素 overflow hidden + 内容层 overflow auto，
   否则高个头的表单会被整页裁掉且不出现滚动条 */
.tabs :deep(.el-tabs__content) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.form {
  max-width: 860px;
  padding-top: 6px;
}
.form :deep(.el-form-item) {
  margin-bottom: 14px;
}
.with-btn {
  display: flex;
  gap: 6px;
  width: 100%;
}

/* 模板 */
.tpl {
  max-width: 900px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 6px;
}
.tpl-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.preview {
  background: var(--paper-2);
  border-left: 3px solid var(--song);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  padding: 8px 12px;
}
.preview .k {
  font-size: 12.5px;
  color: var(--ink-3);
}
.preview .v {
  color: var(--ink);
  word-break: break-all;
}
.vars .k {
  font-size: 12.5px;
  color: var(--ink-3);
  margin-bottom: 6px;
}
.var-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.var {
  display: grid;
  grid-template-columns: 130px 1fr 130px;
  gap: 10px;
  align-items: center;
  border: none;
  background: transparent;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  color: var(--ink-2);
  font-family: var(--font-ui);
}
.var:hover {
  background: var(--paper-2);
  color: var(--zhu);
}
.var .desc {
  color: var(--ink-3);
}
.var .sample {
  color: var(--ink-4);
  text-align: right;
}

/* 磁盘 */
.disk-now {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

/* 通知 */
.notify {
  max-width: 900px;
}
.notify-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 6px;
}
.evt-row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

/* Cookie */
.cookie {
  max-width: 900px;
  padding-top: 6px;
}
.cookie-row {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 10px 12px;
  margin-bottom: 10px;
  background: var(--paper);
}
.cr-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13.5px;
}
.cr-head .nm {
  font-weight: 600;
}
.cr-head .hint {
  margin-left: auto;
}
.cr-head .hint + .hint {
  margin-left: 0;
}
.cr-btns {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
</style>
