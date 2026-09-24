<script setup lang="ts">
/**
 * 录制中心：进行中的任务 + 内置预览播放。
 *
 * 播放为什么要走中继：各平台拉流地址都校验 Referer/UA，渲染进程的 <video> 改不了请求头，
 * 直连必然 403。主进程在 127.0.0.1 起一个只允许白名单域名的中继，带正确请求头取流再转给页面。
 */
import { computed, onMounted, onUnmounted, ref, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { RecordTaskState, StreamVariant } from '@shared/types'
import { state, platformColor, platformName, refreshStats, isPendingRoom } from '../store'
import { formatBytes, formatDuration, formatTime } from '../format'

/* ------------------------------------------------------------ 任务列表 */
const now = ref(Date.now())
let timer: number | null = null

const active = computed(() => state.activeRecords)
const totalBytes = computed(() => active.value.reduce((a, b) => a + (b.sizeBytes || 0), 0))

function progressOf(r: RecordTaskState): number {
  if (r.status === 'recording' && r.startedAt) return Math.max(0, Date.now() - r.startedAt)
  return r.durationMs
}

async function stopOne(r: RecordTaskState): Promise<void> {
  try {
    await window.api.record.stop(r.streamerId)
    await refreshStats()
    ElMessage.info(`已停止录制：${r.streamerName}`)
  } catch (e: unknown) {
    ElMessage.error(`停止失败：${(e as Error)?.message ?? e}`)
  }
}

async function stopAll(): Promise<void> {
  if (!active.value.length) return
  try {
    await ElMessageBox.confirm(`将停止全部 ${active.value.length} 个录制任务并保存文件。`, '确认停止', {
      confirmButtonText: '全部停止',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await window.api.record.stopAll()
    await refreshStats()
    ElMessage.success('已停止全部录制')
  } catch {
    /* 取消 */
  }
}

/* -------------------------------------------------------------- 预览 */
const previewTarget = ref('')
const variants = ref<StreamVariant[]>([])
const variantIndex = ref(0)
const loadingStream = ref(false)
const playing = ref(false)
const playingUrl = ref('')
const videoEl = ref<HTMLVideoElement | null>(null)
/** 每次 teardown 都 +1，强制重建 <video> 节点（见 teardown 注释） */
const videoKey = ref(0)
const playerError = ref('')
/** 当前「播放」会话里已经试过的清晰度下标，用于 fatal 错误时自动降级 */
const triedVariantIndexes = ref<Set<number>>(new Set())
/** 主进程给的 ffmpeg 实时转码兜底地址（HEVC → H.264） */
const transcodeUrl = ref('')
const transcodeTried = ref(false)
/** 转码兜底开始 attach 的时间戳；用于启动期容错（ffmpeg 建立首帧前的 media_error 多为 transient） */
let transcodeAttachTs = 0

let flvPlayer: { destroy: () => void; attachMediaElement: (e: unknown) => void; load: () => void; play: () => void; unload?: () => void; detachMediaElement?: () => void } | null = null
let hlsPlayer: { destroy: () => void; loadSource: (u: string) => void; attachMedia: (e: unknown) => void } | null = null

const livingOptions = computed(() =>
  state.streamers.filter((s) => s.liveStatus === 'living').map((s) => ({
    id: s.id,
    label: `${s.name}（${platformName(s.platform)}）`,
    platform: s.platform,
    roomId: s.roomId
  }))
)

// 还没拿到直播间号的「待开播」主播不能预览/录制，先排除，避免点了报错
const allOptions = computed(() =>
  state.streamers.filter((s) => !isPendingRoom(s)).map((s) => ({
    id: s.id,
    label: `${s.name}（${platformName(s.platform)}）${s.liveStatus === 'living' ? ' · 直播中' : ''}`,
    platform: s.platform,
    roomId: s.roomId
  }))
)

/** 把播放器错误同步写进主进程日志（界面「运行日志」页可见，便于排查） */
function logErr(msg: string): void {
  void window.api.log.write('error', `[preview] ${msg}`)
}
function logInfo(msg: string): void {
  void window.api.log.write('info', `[preview] ${msg}`)
}

function teardown(): void {
  try {
    flvPlayer?.destroy()
  } catch {
    /* ignore */
  }
  try {
    hlsPlayer?.destroy()
  } catch {
    /* ignore */
  }
  flvPlayer = null
  hlsPlayer = null
  playing.value = false
  playingUrl.value = ''
  // 关键：重建 <video> 节点，彻底丢掉上一个 MSE 播放器（hls.js/mpegts）残留的
  // MediaSource 与 error 状态。抖音高清流是 HEVC，原生播放 bufferAddCodecError 失败后
  // 元素带着陈旧 error；转码兜底一 attach，这个陈旧 error 立刻触发 MediaError，
  // 让转码在 0.6s 内被误判失败。换个全新元素就没有这个陈旧状态。
  videoKey.value++
}

async function play(): Promise<void> {
  const id = previewTarget.value
  if (!id) {
    ElMessage.warning('请先选择要预览的主播')
    return
  }
  const opt = allOptions.value.find((o) => o.id === id)
  if (!opt) return

  loadingStream.value = true
  playerError.value = ''
  triedVariantIndexes.value.clear()
  transcodeUrl.value = ''
  transcodeTried.value = false
  teardown()
  try {
    const r = await window.api.preview.start(opt.platform, opt.roomId)
    variants.value = r.variants
    transcodeUrl.value = r.transcodeUrl || ''
    if (!r.variants.length) throw new Error('没有可用的流地址')
    const idx = Math.min(variantIndex.value, r.variants.length - 1)
    variantIndex.value = idx
    await attach(r.variants[idx])
  } catch (e: unknown) {
    playerError.value = (e as Error)?.message ?? String(e)
    ElMessage.error(`预览失败：${playerError.value}`)
  } finally {
    loadingStream.value = false
  }
}

async function attach(v: StreamVariant & { playUrl?: string }): Promise<void> {
  await nextTick()
  const el = videoEl.value
  if (!el) return
  const url = (v as { playUrl?: string }).playUrl ?? v.url
  playingUrl.value = url
  triedVariantIndexes.value.add(variantIndex.value)
  const isTranscode = url.includes('/transcode')
  if (isTranscode) transcodeAttachTs = Date.now()
  logInfo(
    `尝试播放 ${v.label || v.quality}（${v.format}）${isTranscode ? '[转码]' : ''} ${url.slice(0, 160)}`
  )

  // 诊断：先 HEAD 探一次普通中继，确认上游是 200 / 有字节，再喂给 mpegts
  // mpegts 黑屏无报错 = 没法知道上游是 200 0 字节 / 403 / 超时
  // 实时转码端点是流式输出，不能 Range 探测，跳过
  if (!isTranscode) {
  try {
    const t0 = performance.now()
    const head = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-15' } })
    const dt = Math.round(performance.now() - t0)
    const len = head.headers.get('content-length')
    const ct = head.headers.get('content-type') || ''
    // 读 16 字节头确认真有数据
    const buf = await head.arrayBuffer()
    const first = new Uint8Array(buf.slice(0, 4))
    const hex = Array.from(first).map((b) => b.toString(16).padStart(2, '0')).join(' ')
    console.debug('[preview][probe]', { status: head.status, len, ct, dt, firstBytesHex: hex })
    if (head.status >= 400) {
      const errMsg = `中继 ${head.status} · ${head.statusText} · ${ct}`
      playerError.value = errMsg
      ElMessage.error(`预览失败：${errMsg}`)
      void autoFallback(errMsg)
      return
    }
    if (!buf.byteLength) {
      const errMsg = `中继返回空（0 字节）· content-type=${ct}`
      playerError.value = errMsg
      ElMessage.error(`预览失败：${errMsg}`)
      void autoFallback(errMsg)
      return
    }
    // FLV 头 magic = 'FLV' = 0x46 0x4c 0x56
    const isFlv = v.format === 'flv'
    if (isFlv && (first[0] !== 0x46 || first[1] !== 0x4c || first[2] !== 0x56)) {
      const errMsg = `中继返回非 FLV 数据：前 4 字节 = 0x${hex}`
      playerError.value = errMsg
      void autoFallback(errMsg)
      return
    }
  } catch (e: any) {
    const msg = `中继连接失败：${e?.message ?? e}`
    playerError.value = msg
    ElMessage.error(`预览失败：${msg}`)
    void autoFallback(msg)
    return
  }
  }

  // 视频元素的原生事件——驱动蒙层显示/隐藏，确保 hls 卡 0:00 时 playerError 仍可见
  el.onerror = () => {
    const e = el.error
    const codeMap: Record<number, string> = {
      1: 'MEDIA_ERR_ABORTED（用户中止）',
      2: 'MEDIA_ERR_NETWORK（网络错误）',
      3: 'MEDIA_ERR_DECODE（解码错误）',
      4: 'MEDIA_ERR_SRC_NOT_SUPPORTED（源不支持 / MSE 不可用）'
    }
    const code = e?.code ?? 0
    const msg = e ? `${codeMap[code] || `code=${code}`} · ${e.message || ''}` : '未知视频错误'
    playerError.value = msg
    logErr(`video onerror: ${msg} src=${el.src}`)
    console.error('[preview] video error', { code, msg: e?.message, src: el.src })
    playing.value = false
    // 源不支持 / 解码失败（典型是 HEVC）也走降级，最终落到 ffmpeg 转码
    if (code === 3 || code === 4) void autoFallback(msg)
  }
  el.oncanplay = () => {
    console.debug('[preview] video canplay', url)
    // 元数据就绪 → playing 仍为 false，蒙层显示「准备中」
  }
  el.onplaying = () => {
    console.debug('[preview] video playing', url)
    playing.value = true
  }
  el.onwaiting = () => {
    console.debug('[preview] video waiting…', url)
    // 缓冲 / hls 分片加载失败 → 蒙层回来，playerError 可见
    playing.value = false
  }
  el.onstalled = () => {
    console.warn('[preview] video stalled', url)
    playing.value = false
  }

  if (v.format === 'flv') {
    const mod: any = await import('mpegts.js')
    const mpegts = mod?.default ?? mod
    if (!mpegts?.createPlayer || !mpegts.isSupported()) {
      throw new Error('当前环境不支持 FLV 播放（浏览器缺少 MSE）')
    }
    const player = mpegts.createPlayer(
      { type: 'flv', url, isLive: true, cors: true },
      // enableWorker 必须关：打包后页面跑在 file:// 源下，blob Worker 被 Chromium 拦，
      // 开了 worker 起不来导致画面黑屏无报错。
      { enableWorker: false, liveBufferLatencyChasing: true, lazyLoad: false, autoCleanupSourceBuffer: true }
    )

    // 把 mpegts 的全部事件都暴露出来——之前黑屏无报错就是这个不透明
    const events = ['error', 'loading_complete', 'media_info', 'scripting_error', 'metadata', 'statistics_info', 'LoadError', 'LoaderError', 'MediaError']
    for (const evt of events) {
      const h = player.on
        ? player.on(evt, (info: any) => {
            const detail =
              typeof info === 'string'
                ? info
                : info && typeof info === 'object'
                ? JSON.stringify(info).slice(0, 300)
                : String(info ?? '')
            console.debug(`[preview][mpegts] ${evt}`, info)
            if (evt === 'error' || /error/i.test(evt)) {
              const m = `mpegts ${evt}: ${detail}`
              logErr(m)
              // 交给 autoFallback 统一决策（含转码最后一棒 / 启动期容错 / 原生 HEVC 跳转码）
              void autoFallback(m)
            }
          })
        : null
      void h
    }

    player.attachMediaElement(el)
    player.load()
    void player.play().catch((e: any) => {
      playerError.value = `play() 被拒：${e?.message ?? e}`
    })
    flvPlayer = player
  } else if (v.format === 'hls') {
    const mod: any = await import('hls.js')
    const Hls = mod?.default ?? mod
    if (Hls?.isSupported?.()) {
      // enableWorker=false：同 mpegts，file:// 下 hls.js 的 Worker 会被禁用
      // lowLatencyMode=false：抖音高清晰度（FULL_HD1）常为 HEVC，低延迟模式+部分解码器组合下易出现 bufferAppendError
      const h = new Hls({
        enableWorker: false,
        lowLatencyMode: false,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        backBufferLength: 30
      })
      // 挂 hls.js 错误事件，把 FRAG_LOAD_ERROR / MANIFEST 等都暴露出来
      h.on(Hls.Events.ERROR, (_evt: unknown, data: any) => {
        const detail = `${data?.type ?? ''} ${data?.details ?? ''} ${data?.error?.message ?? data?.error ?? ''}`
        console.error('[preview][hls] error', data)
        logErr(`hls ${data?.fatal ? 'fatal' : 'non-fatal'}: ${detail}`)
        if (data?.fatal) {
          playerError.value = `hls fatal: ${detail}`
          void autoFallback(detail)
        } else {
          playerError.value = `hls: ${detail}`
        }
      })
      h.on(Hls.Events.FRAG_LOADED, () => console.debug('[preview][hls] frag loaded'))
      h.on(Hls.Events.MANIFEST_PARSED, () => console.debug('[preview][hls] manifest parsed'))
      hlsPlayer = h
      // 先 attachMedia 再 loadSource，避免 MSE 初始化与数据加载竞速
      h.attachMedia(el)
      h.loadSource(url)
    } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = url
    } else {
      throw new Error('当前环境不支持 HLS 播放')
    }
    void el.play().catch((e: any) => {
      if (e?.name !== 'AbortError') playerError.value = `play() 被拒：${e?.message ?? e}`
    })
  } else {
    el.src = url
    void el.play().catch((e: any) => {
      if (e?.name !== 'AbortError') playerError.value = `play() 被拒：${e?.message ?? e}`
    })
  }
  // 不在这里硬设 playing=true。让视频元素的 oncanplay/onplaying/onwaiting/onerror
  // 驱动它——这样 hls/mpegts 卡死、缓冲、出错时蒙层仍然在，玩家能看到 playerError。
}

async function switchQuality(): Promise<void> {
  if (!variants.value.length) return
  teardown()
  await attach(variants.value[variantIndex.value])
}

/** 追加「转码预览」清晰度并切过去（ffmpeg 实时把 HEVC 转成 H.264） */
async function startTranscode(reason: string): Promise<void> {
  if (!transcodeUrl.value || transcodeTried.value) {
    playerError.value = `${reason}（转码兜底不可用：${transcodeUrl.value ? '已尝试' : '无转码地址'}）`
    logErr(`转码兜底不可用：${playerError.value}`)
    return
  }
  transcodeTried.value = true
  variants.value.push({
    quality: 'transcode',
    label: '转码预览',
    url: transcodeUrl.value,
    format: 'flv'
  })
  variantIndex.value = variants.value.length - 1
  logInfo('原生清晰度编码不受支持，改用 ffmpeg 实时转码预览（HEVC → H.264）')
  ElMessage.warning(
    `${reason}。原生清晰度（HEVC/H.265）浏览器不支持，改用 ffmpeg 实时转码预览（CPU 占用略高）`
  )
  await switchQuality()
}

/** 当前清晰度 fatal 错误时，自动切换到还没试过的下一个清晰度；
 *  全部原始清晰度失败后，改用 ffmpeg 实时转码（HEVC → H.264）兜底预览 */
async function autoFallback(reason: string): Promise<void> {
  logErr(`降级触发：${reason}`)
  // 当前失败项已经由 attach() 加入 set，这里再保险一次
  triedVariantIndexes.value.add(variantIndex.value)

  // 转码兜底（ffmpeg 实时把 HEVC 转 H.264）是最后一棒：
  // 1) 抖音原生清晰度全是 HEVC，换它们必然同样失败（死循环）；
  // 2) ffmpeg 拉流 / 首帧建立有数秒延迟，启动期（前 6s）的 media_error 多为 transient，
  //    等首帧上来即正常播放，不要立即判死。
  // 所以：转码上出错，6s 内忽略，6s 后仍失败才如实报给用户并停止。
  // 用「在播 URL 是否含 /transcode」判断，比依赖 variantIndex 可靠（避免竞态误判）。
  const currentIsTranscode = playingUrl.value.includes('/transcode')
  if (currentIsTranscode) {
    const dt = Date.now() - transcodeAttachTs
    if (dt < 6000) {
      console.warn('[preview][transcode] 启动期错误，grace 6s 内忽略', reason, `dt=${dt}`)
      return
    }
    playerError.value = `转码预览失败：${reason}`
    playing.value = false
    return
  }

  // 编码不支持（HEVC/H.265）时，换原生清晰度没用 —— 直接跳到 ffmpeg 实时转码，
  // 不要再挨个试剩下的原生清晰度（它们也是 HEVC，试了只会反复报错）。
  const isCodecError = /hvc1|hevc|h265|codec|bufferAddCodecError|unsupported|not supported/i.test(reason)
  if (isCodecError) {
    if (transcodeUrl.value && !transcodeTried.value) {
      await startTranscode(reason)
      return
    }
    // 无转码地址可用：HEVC 原生又播不了，只能如实报
    playerError.value = `该清晰度是 HEVC（H.265），当前浏览器无法硬解，且转码兜底不可用：${reason}`
    playing.value = false
    return
  }

  // 非编码类错误（网络/403/空数据等）：换一个还没试过的原生清晰度
  let next = -1
  for (let i = 0; i < variants.value.length; i++) {
    if (variants.value[i].quality === 'transcode') continue
    if (!triedVariantIndexes.value.has(i)) {
      next = i
      break
    }
  }
  if (next === -1) {
    // 原生清晰度试完了：还有转码兜底就上，没有就报真实原因
    if (transcodeUrl.value && !transcodeTried.value) {
      await startTranscode(reason)
    } else {
      playerError.value = `所有清晰度都失败了：${reason}`
      playing.value = false
    }
    return
  }
  variantIndex.value = next
  ElMessage.warning(`${reason}，尝试清晰度：${variants.value[next].label || variants.value[next].quality}`)
  await switchQuality()
}

function stopPreview(): void {
  teardown()
  void window.api.preview.stopAll()
}

/* -------------------------------------------------------------- 弹幕 */
const danmakuList = computed(() => {
  const feed = state.danmakuFeed
  const target = allOptions.value.find((o) => o.id === previewTarget.value)
  if (!target) return feed.slice(-60)
  return feed.filter((f) => f.streamerId === target.id).slice(-60)
})

onMounted(async () => {
  await refreshStats()
  timer = window.setInterval(() => {
    now.value = Date.now()
    void refreshStats()
  }, 2000)
  const first = livingOptions.value[0] ?? allOptions.value[0]
  if (first) previewTarget.value = first.id
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
  stopPreview()
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h2>录制中心</h2>
        <p class="hint">
          进行中 {{ active.length }} 个 · 今日 {{ state.recordStats.totalToday }} 个 /
          {{ formatBytes(state.recordStats.bytesToday) }} · 今日时长 {{ formatDuration(state.recordStats.durationTodayMs) }}
        </p>
      </div>
      <div class="head-actions">
        <el-button @click="refreshStats"><el-icon><Refresh /></el-icon>刷新</el-button>
        <el-button type="danger" plain :disabled="!active.length" @click="stopAll">
          <el-icon><CircleClose /></el-icon>全部停止
        </el-button>
      </div>
    </header>

    <!-- 进行中 -->
    <section class="tasks">
      <div v-if="!active.length" class="panel empty-box">
        <el-icon class="big"><VideoCamera /></el-icon>
        <div>当前没有录制任务</div>
        <div class="hint">在「主播库」对手播中的主播点「录制」，或打开其「自动录制」开关</div>
      </div>
      <div v-for="r in active" :key="r.id" class="panel task">
        <div class="t-head">
          <i class="dot blink" :style="{ background: platformColor(r.platform) }" />
          <span class="nm">{{ r.streamerName }}</span>
          <span class="pill" :class="r.status === 'recording' ? 'recording' : 'offline'">
            {{ r.status === 'recording' ? '录制中' : r.status === 'preparing' ? '准备中' : r.status === 'stopping' ? '停止中' : r.status }}
          </span>
          <span v-if="r.manual" class="pill">手动</span>
          <el-button size="small" type="danger" plain style="margin-left: auto" @click="stopOne(r)">停止</el-button>
        </div>

        <div class="t-stats">
          <div><span class="k">时长</span><b>{{ formatDuration(progressOf(r)) }}</b></div>
          <div><span class="k">大小</span><b>{{ formatBytes(r.sizeBytes) }}</b></div>
          <div><span class="k">速度</span><b>{{ r.speed || '—' }}</b></div>
          <div><span class="k">分段</span><b>{{ r.segments.length }}</b></div>
          <div><span class="k">弹幕</span><b>{{ r.danmakuCount }}</b></div>
          <div v-if="r.retries"><span class="k">重连</span><b class="warn">{{ r.retries }}</b></div>
          <div><span class="k">清晰度</span><b>{{ r.quality || '—' }}</b></div>
        </div>

        <div class="t-file mono" :title="r.currentFile || r.segments[0]">
          {{ r.currentFile || r.segments[0] || '等待落盘…' }}
        </div>

        <div v-if="r.error" class="t-err">{{ r.error }}</div>
      </div>
    </section>

    <!-- 预览 -->
    <div class="preview-grid">
      <section class="panel player-panel">
        <div class="p-head">
          <span class="panel-title">直播预览</span>
          <div class="p-actions">
            <el-select v-model="previewTarget" filterable placeholder="选择主播" style="width: 220px" size="small">
              <el-option-group v-if="livingOptions.length" label="直播中">
                <el-option v-for="o in livingOptions" :key="o.id" :label="o.label" :value="o.id" />
              </el-option-group>
              <el-option-group label="全部主播">
                <el-option v-for="o in allOptions" :key="o.id" :label="o.label" :value="o.id" />
              </el-option-group>
            </el-select>
            <el-select
              v-model="variantIndex"
              size="small"
              style="width: 110px"
              :disabled="!variants.length"
              @change="switchQuality"
            >
              <el-option v-for="(v, i) in variants" :key="i" :label="v.label || v.quality" :value="i" />
            </el-select>
            <el-button v-if="!playing" size="small" type="primary" :loading="loadingStream" @click="play">
              <el-icon><VideoPlay /></el-icon>播放
            </el-button>
            <el-button v-else size="small" @click="stopPreview"><el-icon><VideoPause /></el-icon>停止</el-button>
          </div>
        </div>

        <div class="video-wrap">
          <video :key="videoKey" ref="videoEl" controls muted playsinline />
          <div v-if="!playing" class="video-mask">
            <div v-if="playerError" class="err">{{ playerError }}</div>
            <div v-else class="hint">选择主播后点「播放」，可在录制前确认画面与清晰度</div>
          </div>
        </div>

        <div v-if="playingUrl" class="p-url mono" :title="playingUrl">{{ playingUrl }}</div>
      </section>

      <section class="panel danmaku-panel">
        <div class="p-head">
          <span class="panel-title">实时弹幕</span>
          <span class="hint">{{ danmakuList.length }} 条</span>
        </div>
        <div v-if="!danmakuList.length" class="empty">暂无弹幕（在主播库里打开「弹幕」开关即可）</div>
        <ul v-else class="dm-list">
          <li v-for="(d, i) in danmakuList" :key="i" :class="d.message.type">
            <span class="u">{{ d.message.user || '匿名' }}</span>
            <span class="x">{{ d.message.text }}</span>
            <span class="t mono">{{ formatTime(d.message.ts, false) }}</span>
          </li>
        </ul>
      </section>
    </div>
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

.tasks {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
  gap: 10px;
  flex: 0 0 auto;
  max-height: 42vh;
  overflow: auto;
}
.empty-box {
  grid-column: 1 / -1;
  padding: 26px;
  text-align: center;
  color: var(--ink-2);
}
.empty-box .big {
  font-size: 26px;
  color: var(--ink-4);
  display: block;
  margin-bottom: 6px;
}

.task {
  padding: 10px 12px;
}
.t-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 4px;
}
.t-head .nm {
  font-weight: 600;
}
.t-title {
  color: var(--ink-3);
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 6px;
}
.t-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 12.5px;
  margin-bottom: 6px;
}
.t-stats .k {
  color: var(--ink-3);
  margin-right: 4px;
}
.t-stats b {
  font-family: var(--font-serif);
  font-size: 13.5px;
}
.t-stats b.warn {
  color: var(--jin);
}
.t-file {
  color: var(--ink-4);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.t-err {
  margin-top: 6px;
  color: var(--zhu);
  font-size: 12.5px;
  background: var(--zhu-soft);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
}

.preview-grid {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(260px, 1fr);
  gap: 12px;
}
.player-panel,
.danmaku-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 12px 14px;
}
.p-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.p-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.video-wrap {
  position: relative;
  flex: 1 1 auto;
  min-height: 200px;
  background: #000;
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.video-wrap video {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
  background: #000;
}
.video-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 20px;
  color: var(--ink-3);
  background: rgba(0, 0, 0, 0.55);
}
.video-mask .err {
  color: #ffd7d4;
}
.p-url {
  margin-top: 6px;
  color: var(--ink-4);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dm-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  flex: 1 1 auto;
  min-height: 0;
}
.dm-list li {
  display: flex;
  gap: 6px;
  padding: 3px 0;
  font-size: 13px;
  border-bottom: 1px dashed var(--line);
}
.dm-list .u {
  flex: 0 0 auto;
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--lan);
}
.dm-list .x {
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-all;
  color: var(--ink);
}
.dm-list .t {
  flex: 0 0 auto;
  color: var(--ink-4);
  font-size: 11.5px;
}
.dm-list li.gift .x,
.dm-list li.superchat .x {
  color: var(--jin);
}
.dm-list li.enter .x,
.dm-list li.like .x {
  color: var(--ink-3);
}
</style>
