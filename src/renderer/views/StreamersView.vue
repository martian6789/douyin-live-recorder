<script setup lang="ts">
/**
 * 主播库：添加 / 筛选 / 排序 / 标签 / 导入导出 / 一键检测或开录。
 * 这是全程序的数据源页，写操作后都会触发主进程的「同步监控 + 同步弹幕」。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { DouyinSearchUser, PlatformId, Streamer } from '@shared/types'
import { state, refreshStreamers, refreshTags, platformColor, platformName, tagOf, isPendingRoom, roomLabel } from '../store'
import { fromNow } from '../format'

const platforms = computed(() => state.meta?.platformMeta ?? [])

/* ------------------------------------------------------------ 添加表单 */
// 默认抖音：绝大多数场景都在抖音，少一次下拉切换
const addForm = reactive({
  platform: 'douyin' as PlatformId,
  input: '',
  name: '',
  autoRecord: false,
  danmakuEnabled: true
})
const adding = ref(false)

/** 抖音支持「主播主页链接 / 抖音号 / 作品链接」：主播没开播时也能先加进来挂监控 */
const addPlaceholder = computed(() =>
  addForm.platform === 'douyin'
    ? '直播链接 / 房间号 / 抖音号 / 作品链接 / 主播主页链接（未开播也能加，开播自动识别）'
    : '粘贴直播间链接，或直接填房间号，如 5440'
)

async function doAdd(): Promise<void> {
  const raw = addForm.input.trim()
  if (!raw) {
    ElMessage.warning('请输入直播间链接或房间号')
    return
  }
  adding.value = true
  try {
    let r: Awaited<ReturnType<typeof window.api.streamer.add>> | null = null
    try {
      r = await window.api.streamer.add({
        platform: addForm.platform,
        input: raw,
        name: addForm.name || undefined,
        autoRecord: addForm.autoRecord,
        danmakuEnabled: addForm.danmakuEnabled
      })
    } catch {
      r = null
    }
    // 抖音：直接识别不到房间号时（如用户粘的是「主播ID / 作品链接 / 主页链接」），
    // 自动走「定位主播」解析并入库监控，一步到位。
    if ((!r || (r.error && /无法识别/.test(r.error))) && addForm.platform === 'douyin') {
      const ra = await window.api.streamer.resolveAdd({
        input: raw,
        autoRecord: addForm.autoRecord,
        danmakuEnabled: addForm.danmakuEnabled
      })
      if (!ra.ok) {
        ElMessage.error(ra.error || '未能定位到主播')
        return
      }
      await refreshStreamers()
      addForm.input = ''
      addForm.name = ''
      if (ra.created) {
        if (ra.awaitingRoom) {
          ElMessage.success(
            `已加入监控：${ra.name} —— 他开播时会自动识别直播间号` +
              (addForm.autoRecord ? '' : '；要自动录记得打开列表里的「自动录」')
          )
        } else {
          ElMessage.success(`已添加：${ra.name}`)
          if (ra.checkError) ElMessage.warning(`但探测房间信息失败：${ra.checkError}`)
        }
      } else {
        ElMessage.info(`已存在：${ra.name}`)
      }
      return
    }

    state.streamers = r!.list
    addForm.input = ''
    addForm.name = ''
    if (r!.created) {
      if (r!.streamer?.awaitingRoom) {
        ElMessage.success(
          `已加入监控：${r!.streamer?.name} —— 他开播时会自动识别直播间号` +
            (r!.streamer?.autoRecord ? '' : '；要自动录记得打开列表里的「自动录」')
        )
      } else {
        ElMessage.success(`已添加：${r!.streamer?.name}`)
        // 探测房间信息失败也照样入库，但要把真实原因亮给用户
        if (r!.checkError) {
          ElMessage.warning(`但探测房间信息失败：${r!.checkError}（主播名可能不准，稍后点「检测」会自动补全）`)
        }
      }
    } else {
      ElMessage.info(`已存在：${r!.streamer?.name}`)
    }
  } catch (e: unknown) {
    ElMessage.error(`添加失败：${(e as Error)?.message ?? e}`)
  } finally {
    adding.value = false
  }
}

/* ------------------------------------------------------------ 批量添加 */
const batchOpen = ref(false)
const batch = reactive({ platform: 'douyin' as PlatformId, text: '' })
const batchBusy = ref(false)
const batchResult = ref<null | { added: number; skipped: number; failed: number }>(null)

async function doBatchAdd(): Promise<void> {
  if (!batch.text.trim()) {
    ElMessage.warning('请粘贴链接，一行一个')
    return
  }
  batchBusy.value = true
  batchResult.value = null
  try {
    const r = await window.api.streamer.batchAdd(batch.platform, batch.text)
    batchResult.value = { added: r.added, skipped: r.skipped, failed: r.failed }
    await refreshStreamers()
    ElMessage.success(`添加 ${r.added} 个，跳过 ${r.skipped}，失败 ${r.failed}`)
  } catch (e: unknown) {
    ElMessage.error(`批量添加失败：${(e as Error)?.message ?? e}`)
  } finally {
    batchBusy.value = false
  }
}

/* ------------------------------------------------------ 搜索主播（抖音） */
const searchOpen = ref(false)
const searchKw = ref('')
const searching = ref(false)
const searchErr = ref('')
const searchNeedCookie = ref(false)
const searchDone = ref(false)
const results = ref<DouyinSearchUser[]>([])
const importingUid = ref('')

async function doSearch(): Promise<void> {
  const kw = searchKw.value.trim()
  if (!kw) {
    ElMessage.warning('请输入主播昵称或抖音号')
    return
  }
  searching.value = true
  searchErr.value = ''
  searchNeedCookie.value = false
  searchDone.value = false
  results.value = []
  try {
    const r = await window.api.streamer.searchDouyin(kw)
    results.value = r.users ?? []
    searchDone.value = true
    searchNeedCookie.value = !!r.needCookie
    if (r.error) searchErr.value = r.error
    else if (!results.value.length) searchErr.value = '没有搜到匹配的主播'
  } catch (e: unknown) {
    searchErr.value = `搜索失败：${(e as Error)?.message ?? e}`
  } finally {
    searching.value = false
  }
}

function alreadyAdded(u: DouyinSearchUser): boolean {
  return state.streamers.some(
    (s) =>
      s.platform === 'douyin' &&
      ((!!u.roomId && s.roomId === u.roomId) || (!!u.secUid && s.secUid === u.secUid))
  )
}

/**
 * 导入搜索结果。
 * 直播中 → 直接带直播间号入库；未开播 → 用主页 sec_uid 入库并挂上监控，
 * 等他开播时监控会自动反查到直播间号，配合「开播自动录」直接开录。
 * 抖音未开播时并不存在对外的直播间号，这是平台限制，只能这样绕。
 */
async function importUser(u: DouyinSearchUser): Promise<void> {
  if (!u.roomId && !u.secUid && !u.liveUrl) return
  importingUid.value = u.secUid
  try {
    const r = await window.api.streamer.add({
      platform: 'douyin',
      input: u.roomUrl || u.liveUrl || u.homeUrl || '',
      secUid: u.secUid,
      homeUrl: u.homeUrl,
      liveUrl: u.liveUrl,
      douyinId: u.douyinId,
      avatar: u.avatar,
      name: u.nickname,
      // 未开播才加进来的，目的就是等他开播抓一次 —— 顺手把自动录打开
      autoRecord: !u.roomId || undefined
    })
    state.streamers = r.list
    const nm = r.streamer?.name ?? u.nickname
    if (r.created) {
      if (u.roomId) ElMessage.success(`已导入：${nm}`)
      else ElMessage.success(`已加入监控：${nm} —— 他开播时会自动识别直播间号`)
      if (r.checkError && u.roomId) ElMessage.warning(`探测房间失败：${r.checkError}`)
    } else {
      ElMessage.info(`主播库里已有：${nm}`)
    }
  } catch (e: unknown) {
    ElMessage.error(`导入失败：${(e as Error)?.message ?? e}`)
  } finally {
    importingUid.value = ''
  }
}

async function loginDouyin(): Promise<void> {
  await window.api.credential.douyinLoginOpen()
  ElMessage.info('已打开登录窗口：登录后回到这里点「我已登录，导入 Cookie」')
}

async function importCookie(): Promise<void> {
  const r = await window.api.credential.douyinLoginImport()
  if (r.ok) ElMessage.success(`Cookie 已导入（${r.length} 字符），可以重新搜索了`)
  else ElMessage.error(r.error ?? '导入失败')
}

async function openHome(u: DouyinSearchUser): Promise<void> {
  if (u.homeUrl) await window.api.app.openExternal(u.homeUrl)
}

async function openLive(u: DouyinSearchUser): Promise<void> {
  const url = u.liveUrl || u.roomUrl || u.homeUrl
  if (url) await window.api.app.openExternal(url)
}

/* ------------------------------------------------- 导入我的关注（抖音） */
const followOpen = ref(false)
const followLoading = ref(false)
const followImporting = ref(false)
const followErr = ref('')
const followNeedCookie = ref(false)
const followOnlyLiving = ref(false)
const followScanned = ref(0)
const followUsers = ref<DouyinSearchUser[]>([])
const followSelected = ref<string[]>([])

const followRows = computed(() =>
  followOnlyLiving.value ? followUsers.value.filter((u) => u.roomId) : followUsers.value
)

async function openFollow(): Promise<void> {
  followOpen.value = true
  await loadFollowing()
}

async function loadFollowing(): Promise<void> {
  followLoading.value = true
  followErr.value = ''
  followNeedCookie.value = false
  try {
    const r = await window.api.streamer.douyinFollowing(10)
    followUsers.value = r.users ?? []
    followScanned.value = r.scanned ?? r.users?.length ?? 0
    followSelected.value = (r.users ?? []).filter((u) => u.roomId).map((u) => u.secUid)
    if (r.error) {
      followErr.value = r.error
      followNeedCookie.value = !!r.needCookie
    }
  } catch (e: unknown) {
    followErr.value = (e as Error)?.message ?? String(e)
  } finally {
    followLoading.value = false
  }
}

function toggleAllFollow(on: boolean): void {
  followSelected.value = on ? followRows.value.map((u) => u.secUid) : []
}

async function importSelectedFollow(): Promise<void> {
  const picked = followUsers.value.filter((u) => followSelected.value.includes(u.secUid))
  if (!picked.length) {
    ElMessage.warning('先勾选要导入的主播')
    return
  }
  followImporting.value = true
  try {
    const r = await window.api.streamer.importDouyinUsers(picked)
    state.streamers = await window.api.streamer.list()
    ElMessage.success(
      `导入完成：新增 ${r.added} · 已存在 ${r.skipped} · 失败 ${r.failed}` +
        (r.failed ? `（${r.errors.slice(0, 2).join('；')}）` : '')
    )
    if (r.added) followOpen.value = false
  } catch (e: unknown) {
    ElMessage.error(`导入失败：${(e as Error)?.message ?? e}`)
  } finally {
    followImporting.value = false
  }
}

/* -------------------------------------------------------------- 筛选 */
const filter = reactive({
  platform: '' as '' | PlatformId,
  tagId: '',
  keyword: '',
  onlyLiving: false,
  onlyAuto: false
})

const rows = computed(() => {
  let list = state.streamers
  if (filter.platform) list = list.filter((s) => s.platform === filter.platform)
  if (filter.tagId) list = list.filter((s) => s.tags.includes(filter.tagId))
  if (filter.onlyLiving) list = list.filter((s) => s.liveStatus === 'living')
  if (filter.onlyAuto) list = list.filter((s) => s.autoRecord)
  const kw = filter.keyword.trim().toLowerCase()
  if (kw) {
    list = list.filter(
      (s) =>
        s.name.toLowerCase().includes(kw) ||
        s.roomId.includes(kw) ||
        (s.roomTitle ?? '').toLowerCase().includes(kw) ||
        (s.remark ?? '').toLowerCase().includes(kw)
    )
  }
  return list
})

/* ------------------------------------------------------------ 行操作 */
const checkingId = ref('')

async function checkOne(s: Streamer): Promise<void> {
  checkingId.value = s.id
  try {
    const r = await window.api.monitor.checkOne(s.id)
    s.liveStatus = r.status as Streamer['liveStatus']
    s.lastCheckAt = Date.now()
    s.checkError = r.error
    const label =
      r.status === 'living' ? '正在直播' : r.status === 'offline' ? '未开播' : r.status === 'error' ? `检测失败：${r.error ?? ''}` : r.status
    if (r.status === 'error') ElMessage.warning(label)
    else ElMessage.success(label)
  } catch (e: unknown) {
    ElMessage.error(`检测失败：${(e as Error)?.message ?? e}`)
  } finally {
    checkingId.value = ''
  }
}

async function startRecord(s: Streamer): Promise<void> {
  try {
    await window.api.record.start(s.id)
    ElMessage.success(`开始录制：${s.name}`)
    state.view = 'recording'
  } catch (e: unknown) {
    ElMessage.error(`录制失败：${(e as Error)?.message ?? e}`)
  }
}

async function stopRecord(s: Streamer): Promise<void> {
  await window.api.record.stop(s.id)
  ElMessage.info('已停止录制')
}

async function toggleAuto(s: Streamer): Promise<void> {
  const next = await window.api.streamer.toggleAutoRecord(s.id)
  s.autoRecord = next
  if (next && state.config && !state.config.autoRecord) {
    // 关键易踩的坑：主播级开了 ≠ 真的会自动录。
    // 还需要设置页的「全局自动录制」开关。
    // 直接帮用户打开，免得还要进设置页。
    await window.api.config.set({ autoRecord: true })
    state.config = { ...state.config, autoRecord: true }
    ElMessage.success(`已开启「${s.name}」的自动录制（同时打开了「全局自动录制」开关）`)
  } else {
    ElMessage.success(next ? `已开启「${s.name}」的自动录制` : `已关闭「${s.name}」的自动录制`)
  }
}

async function toggleDanmaku(s: Streamer): Promise<void> {
  const next = !s.danmakuEnabled
  await window.api.danmaku.setStreamerEnabled(s.id, next)
  s.danmakuEnabled = next
}

async function openLiveRow(s: Streamer): Promise<void> {
  const url = s.liveUrl || s.homeUrl
  if (url) await window.api.app.openExternal(url)
}

async function removeOne(s: Streamer): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定从主播库移除「${s.name}」吗？已录制的文件不会被删除。`,
      '移除确认',
      { confirmButtonText: '移除', cancelButtonText: '取消', type: 'warning' }
    )
    state.streamers = await window.api.streamer.remove(s.id)
    ElMessage.success('已移除')
  } catch {
    /* 取消 */
  }
}

async function move(s: Streamer, dir: 'up' | 'down' | 'bottom'): Promise<void> {
  if (dir === 'up') state.streamers = await window.api.streamer.moveUp(s.id)
  else if (dir === 'down') state.streamers = await window.api.streamer.moveDown(s.id)
  else state.streamers = await window.api.streamer.moveToBottom(s.id)
}

async function top(s: Streamer): Promise<void> {
  state.streamers = await window.api.streamer.toggleTop(s.id)
}

/* ------------------------------------------------------------ 编辑抽屉 */
const editOpen = ref(false)
const editing = ref<Streamer | null>(null)
const editForm = reactive({
  name: '',
  remark: '',
  tags: [] as string[],
  saveDir: '',
  quality: '',
  autoRecord: false,
  danmakuEnabled: true
})

function openEdit(s: Streamer): void {
  editing.value = s
  editForm.name = s.name
  editForm.remark = s.remark ?? ''
  editForm.tags = [...s.tags]
  editForm.saveDir = s.saveDir ?? ''
  editForm.quality = s.quality ?? ''
  editForm.autoRecord = s.autoRecord
  editForm.danmakuEnabled = s.danmakuEnabled
  editOpen.value = true
}

async function saveEdit(): Promise<void> {
  if (!editing.value) return
  state.streamers = await window.api.streamer.update(editing.value.id, {
    name: editForm.name,
    remark: editForm.remark,
    tags: editForm.tags,
    saveDir: editForm.saveDir || undefined,
    quality: editForm.quality || undefined,
    autoRecord: editForm.autoRecord,
    danmakuEnabled: editForm.danmakuEnabled
  })
  editOpen.value = false
  ElMessage.success('已保存')
}

async function pickSaveDir(): Promise<void> {
  const dir = await window.api.config.selectDirectory('选择该主播的单独保存目录')
  if (dir) editForm.saveDir = dir
}

/* -------------------------------------------------------------- 标签 */
const tagOpen = ref(false)
const newTag = reactive({ name: '', color: '#a8322d' })

async function addTag(): Promise<void> {
  if (!newTag.name.trim()) return
  state.tags = await window.api.tags.add(newTag.name.trim(), newTag.color)
  newTag.name = ''
  ElMessage.success('标签已创建')
}

async function removeTag(id: string): Promise<void> {
  state.tags = await window.api.tags.remove(id)
  await refreshStreamers()
}

/* ---------------------------------------------------------- 导入导出 */
async function exportData(): Promise<void> {
  const r = await window.api.streamer.exportData()
  if (r.ok) ElMessage.success(`已导出到 ${r.file}`)
}

async function importData(): Promise<void> {
  const r = await window.api.streamer.importData()
  if (!r.ok) {
    if (r.error) ElMessage.error(r.error)
    return
  }
  await Promise.all([refreshStreamers(), refreshTags()])
  ElMessage.success(`导入完成：新增 ${r.added ?? 0}，跳过 ${r.skipped ?? 0}`)
}

onMounted(async () => {
  await Promise.all([refreshStreamers(), refreshTags()])
})
</script>

<template>
  <div class="page">
    <!-- 全局自动录制开关状态条（持久可见，不只是一闪过的 ElMessage） -->
    <el-alert
      v-if="state.config && !state.config.autoRecord"
      type="warning"
      :closable="false"
      show-icon
      class="global-warn"
    >
      <template #title>
        全局自动录制开关未打开 — 主播列表里的「开播自动录」勾上也不会触发录制
      </template>
      <template #default>
        切换「设置 → 录制 → 全局自动录制」打开即可生效（用于临时全停也能用）
      </template>
    </el-alert>

    <header class="page-head">
      <div>
        <h2>主播库</h2>
        <p class="hint">
          共 {{ state.streamers.length }} 个 · 直播中 {{ state.streamers.filter((s) => s.liveStatus === 'living').length }} ·
          自动录制 {{ state.streamers.filter((s) => s.autoRecord).length }}
        </p>
      </div>
      <div class="head-actions">
        <el-button type="primary" @click="searchOpen = true"><el-icon><Search /></el-icon>搜索主播</el-button>
        <el-button type="primary" @click="openFollow"><el-icon><UserFilled /></el-icon>导入我的关注</el-button>
        <el-button @click="tagOpen = true"><el-icon><PriceTag /></el-icon>标签</el-button>
        <el-button @click="importData"><el-icon><Upload /></el-icon>导入</el-button>
        <el-button @click="exportData"><el-icon><Download /></el-icon>导出</el-button>
        <el-button type="primary" @click="batchOpen = true"><el-icon><DocumentAdd /></el-icon>批量添加</el-button>
      </div>
    </header>

    <!-- 添加一行 -->
    <section class="panel add-bar">
      <el-select v-model="addForm.platform" style="width: 118px">
        <el-option v-for="p in platforms" :key="p.id" :label="p.name" :value="p.id" />
      </el-select>
      <el-input
        v-model="addForm.input"
        :placeholder="addPlaceholder"
        clearable
        style="flex: 1 1 auto"
        @keyup.enter="doAdd"
      />
      <el-input v-model="addForm.name" placeholder="备注名（可选）" clearable style="width: 150px" />
      <el-checkbox v-model="addForm.autoRecord">开播自动录</el-checkbox>
      <el-checkbox v-model="addForm.danmakuEnabled">记录弹幕</el-checkbox>
      <el-button type="primary" :loading="adding" @click="doAdd">
        <el-icon><Plus /></el-icon>添加
      </el-button>
    </section>

    <!-- 筛选 -->
    <section class="panel filter-bar">
      <el-select v-model="filter.platform" placeholder="全部平台" clearable style="width: 130px">
        <el-option v-for="p in platforms" :key="p.id" :label="p.name" :value="p.id" />
      </el-select>
      <el-select v-model="filter.tagId" placeholder="全部标签" clearable style="width: 130px">
        <el-option v-for="t in state.tags" :key="t.id" :label="t.name" :value="t.id" />
      </el-select>
      <el-input v-model="filter.keyword" placeholder="搜索主播名 / 房间号 / 标题" clearable style="width: 240px" />
      <el-checkbox v-model="filter.onlyLiving">只看直播中</el-checkbox>
      <el-checkbox v-model="filter.onlyAuto">只看自动录制</el-checkbox>
      <span class="hint" style="margin-left: auto">显示 {{ rows.length }} / {{ state.streamers.length }}</span>
    </section>

    <!-- 列表 -->
    <section class="panel table-wrap">
      <el-table :data="rows" size="small" :row-key="(r: Streamer) => r.id" empty-text="暂无主播，先在上方添加">
        <el-table-column label="" width="42">
          <template #default="{ row }">
            <el-icon v-if="row.top" class="top-mark" title="已置顶"><StarFilled /></el-icon>
            <el-icon v-else class="dim" title="未置顶"><Star /></el-icon>
          </template>
        </el-table-column>

        <el-table-column label="平台" width="106">
          <template #default="{ row }">
            <span class="plat">
              <i class="dot" :style="{ background: platformColor(row.platform) }" />
              {{ platformName(row.platform) }}
            </span>
          </template>
        </el-table-column>

        <el-table-column label="主播" min-width="220" class-name="col-name">
          <template #default="{ row }">
            <div class="nm-cell">
              <div class="nm-row1">
                <span class="nm" :title="row.name">{{ row.name }}</span>
                <span v-if="row.remark" class="remark" :title="row.remark">（{{ row.remark }}）</span>
              </div>
              <div class="nm-row2">
                <span v-if="isPendingRoom(row)" class="rid-pending">待开播 · 监控中</span>
                <span v-else class="mono rid" :title="row.roomId">{{ row.roomId }}</span>
                <a
                  v-if="row.liveUrl"
                  class="cell-live"
                  :href="row.liveUrl"
                  title="打开直播间 / 主页"
                  @click.prevent="openLiveRow(row)"
                  >▶直播</a
                >
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="标签" min-width="120">
          <template #default="{ row }">
            <span
              v-for="tid in row.tags"
              :key="tid"
              class="tag"
              :style="{ background: (tagOf(tid)?.color ?? '#999') + '22', color: tagOf(tid)?.color ?? '#999' }"
            >
              {{ tagOf(tid)?.name ?? tid }}
            </span>
            <span v-if="!row.tags.length" class="hint">—</span>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="108">
          <template #default="{ row }">
            <span class="pill" :class="row.liveStatus === 'living' ? 'living' : row.liveStatus === 'error' ? 'error' : 'offline'">
              <i v-if="row.liveStatus === 'living'" class="dot blink" :style="{ background: 'currentColor' }" />
              {{ row.liveStatus === 'living' ? '直播中' : row.liveStatus === 'error' ? '检测失败' : row.liveStatus === 'checking' ? '检测中' : '未开播' }}
            </span>
            <div class="hint tiny" :title="row.checkError">{{ fromNow(row.lastCheckAt) }}</div>
          </template>
        </el-table-column>

        <el-table-column label="自动录" width="72" align="center">
          <template #default="{ row }">
            <el-switch :model-value="row.autoRecord" size="small" @change="toggleAuto(row)" />
          </template>
        </el-table-column>

        <el-table-column label="弹幕" width="64" align="center">
          <template #default="{ row }">
            <el-switch :model-value="row.danmakuEnabled" size="small" @change="toggleDanmaku(row)" />
          </template>
        </el-table-column>

        <el-table-column label="排序" width="96" align="center">
          <template #default="{ row }">
            <el-button link size="small" title="置顶" @click="top(row)"><el-icon><Top /></el-icon></el-button>
            <el-button link size="small" title="上移" @click="move(row, 'up')"><el-icon><ArrowUp /></el-icon></el-button>
            <el-button link size="small" title="下移" @click="move(row, 'down')"><el-icon><ArrowDown /></el-icon></el-button>
            <el-button link size="small" title="置底" @click="move(row, 'bottom')"><el-icon><Bottom /></el-icon></el-button>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="252" fixed="right" class-name="ops-col">
          <template #default="{ row }">
            <el-button
              v-if="state.activeRecords.some((r) => r.streamerId === row.id)"
              size="small"
              type="danger"
              plain
              @click="stopRecord(row)"
            >
              停止
            </el-button>
            <el-button
              v-else
              size="small"
              type="primary"
              plain
              :disabled="row.liveStatus !== 'living'"
              @click="startRecord(row)"
            >
              录制
            </el-button>
            <el-button size="small" :loading="checkingId === row.id" @click="checkOne(row)">检测</el-button>
            <el-button size="small" @click="openEdit(row)">编辑</el-button>
            <!-- 移除固定放在最后，并用左边距与前面按钮隔开，避免贴着「录制」误点 -->
            <el-button size="small" type="danger" link class="remove-btn" @click="removeOne(row)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <!-- 搜索主播（抖音） -->
    <el-dialog v-model="searchOpen" title="搜索抖音主播" width="760" class="search-dlg">
      <div class="search-bar">
        <el-input
          v-model="searchKw"
          placeholder="输入主播昵称 / 抖音号 / 作品链接 / 主页链接，如「疯狂小杨哥」或 32093862395"
          clearable
          style="flex: 1 1 auto"
          @keyup.enter="doSearch"
        />
        <el-button type="primary" :loading="searching" @click="doSearch">
          <el-icon><Search /></el-icon>搜索
        </el-button>
      </div>

      <el-alert
        v-if="searchNeedCookie"
        type="warning"
        :closable="false"
        show-icon
        class="cookie-warn"
        title="抖音搜索需要登录态 Cookie"
      >
        <template #default>
          <div class="cookie-warn-body">
            <span>抖音的搜索接口是登录态接口，未登录会被拒绝。点下面的按钮在内置窗口里登录一次即可，登录态会保存在本机。</span>
            <div class="cookie-actions">
              <el-button size="small" type="primary" @click="loginDouyin">打开抖音登录页</el-button>
              <el-button size="small" @click="importCookie">我已登录，导入 Cookie</el-button>
            </div>
          </div>
        </template>
      </el-alert>

      <p class="hint search-tip">
        <b>未开播也能加</b>：抖音只在主播开播时才产生直播间号，没开播时谁都拿不到 —— 但主播主页是永久固定的。
        直接点「加入监控」，软件会记下这位主播，他一开播就自动识别直播间号，并按你的设置自动录制。
      </p>

      <div v-if="searchErr" class="search-err">{{ searchErr }}</div>

      <ul v-if="results.length" class="search-list">
        <li v-for="u in results" :key="u.secUid">
          <img v-if="u.avatar" class="avatar" :src="u.avatar" alt="" />
          <div v-else class="avatar avatar-empty">{{ u.nickname.slice(0, 1) }}</div>

          <div class="meta">
            <div class="line1">
              <span class="nm">{{ u.nickname }}</span>
              <span v-if="u.douyinId" class="mono dyid">抖音号 {{ u.douyinId }}</span>
              <span v-if="u.roomId" class="pill living">
                <i class="dot blink" :style="{ background: 'currentColor' }" />直播中
              </span>
              <span v-else class="pill offline">未在播</span>
            </div>
            <div class="line2 hint">
              <span v-if="u.followers">粉丝 {{ (u.followers / 10000).toFixed(1) }} 万</span>
              <span v-if="u.roomId" class="mono">房间号 {{ u.roomId }}</span>
              <span v-if="u.signature" class="sig" :title="u.signature">{{ u.signature }}</span>
            </div>
          </div>

          <div class="ops">
            <el-button
              size="small"
              type="primary"
              :loading="importingUid === u.secUid"
              :disabled="alreadyAdded(u)"
              @click="importUser(u)"
            >
              {{ alreadyAdded(u) ? '已在库' : u.roomId ? '导入' : '加入监控' }}
            </el-button>
            <el-button size="small" @click="openLive(u)">看直播</el-button>
            <el-button size="small" @click="openHome(u)">主页</el-button>
          </div>
        </li>
      </ul>

      <div v-else-if="searchDone && !searchErr" class="empty">没有搜到主播</div>

      <template #footer>
        <el-button @click="searchOpen = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 导入我的关注（抖音） -->
    <el-dialog v-model="followOpen" title="导入我的抖音关注" width="760" class="search-dlg">
      <p class="hint search-tip">
        读取你抖音账号关注过的主播。<b>正在直播的会直接带直播间号</b>；没开播的按主页加入监控，他开播时自动补号并按设置录制。
      </p>

      <el-alert v-if="followNeedCookie" type="warning" :closable="false" class="cookie-warn">
        <template #default>
          <div class="cookie-warn-body">
            <span>{{ followErr || '需要抖音登录态才能读取关注列表。' }}</span>
            <div class="cookie-actions">
              <el-button size="small" type="primary" @click="loginDouyin">打开抖音登录页</el-button>
              <el-button size="small" @click="importCookie">我已登录，导入 Cookie</el-button>
            </div>
          </div>
        </template>
      </el-alert>
      <div v-else-if="followErr" class="search-err">{{ followErr }}</div>

      <div class="follow-bar">
        <el-checkbox v-model="followOnlyLiving">只看正在直播的</el-checkbox>
        <span class="hint" style="margin-left: auto">
          共 {{ followScanned }} 个关注 · 显示 {{ followRows.length }}
        </span>
        <el-button size="small" :loading="followLoading" @click="loadFollowing">重新读取</el-button>
      </div>

      <div v-loading="followLoading" class="follow-list">
        <el-checkbox-group v-model="followSelected">
          <div v-for="u in followRows" :key="u.secUid" class="follow-row">
            <el-checkbox :value="u.secUid" class="follow-check" />
            <img v-if="u.avatar" class="avatar" :src="u.avatar" alt="" />
            <div v-else class="avatar avatar-empty">{{ u.nickname.slice(0, 1) }}</div>
            <div class="meta">
              <div class="line1">
                <span class="nm">{{ u.nickname }}</span>
                <span v-if="u.douyinId" class="mono dyid">抖音号 {{ u.douyinId }}</span>
                <span v-if="u.roomId" class="pill living">
                  <i class="dot blink" :style="{ background: 'currentColor' }" />直播中
                </span>
                <span v-else class="pill offline">未在播</span>
              </div>
              <div class="line2 hint">
                <span v-if="u.followers">粉丝 {{ (u.followers / 10000).toFixed(1) }} 万</span>
                <span v-if="u.roomId" class="mono">直播号 {{ u.roomId }}</span>
                <span v-else class="mono">将按主页监控，开播自动识别</span>
              </div>
            </div>
          </div>
        </el-checkbox-group>
        <div v-if="!followLoading && !followRows.length" class="empty">没有读到关注列表</div>
      </div>

      <template #footer>
        <div class="follow-foot">
          <div class="hint">
            <el-button link size="small" @click="toggleAllFollow(true)">全选</el-button>
            <el-button link size="small" @click="toggleAllFollow(false)">全不选</el-button>
            <span>已选 {{ followSelected.length }}</span>
          </div>
          <div>
            <el-button @click="followOpen = false">关闭</el-button>
            <el-button type="primary" :loading="followImporting" @click="importSelectedFollow">
              导入所选
            </el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <!-- 批量添加 -->
    <el-dialog v-model="batchOpen" title="批量添加直播间" width="560">
      <el-form label-width="70px">
        <el-form-item label="平台">
          <el-select v-model="batch.platform" style="width: 160px">
            <el-option v-for="p in platforms" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="链接">
          <el-input
            v-model="batch.text"
            type="textarea"
            :rows="8"
            placeholder="一行一个链接或房间号，自动去重"
          />
        </el-form-item>
      </el-form>
      <el-alert v-if="batchResult" type="success" :closable="false">
        添加 {{ batchResult.added }} 个，跳过 {{ batchResult.skipped }} 个，失败 {{ batchResult.failed }} 个
      </el-alert>
      <template #footer>
        <el-button @click="batchOpen = false">关闭</el-button>
        <el-button type="primary" :loading="batchBusy" @click="doBatchAdd">开始添加</el-button>
      </template>
    </el-dialog>

    <!-- 标签管理 -->
    <el-dialog v-model="tagOpen" title="标签管理" width="460">
      <div class="tag-add">
        <el-input v-model="newTag.name" placeholder="新标签名" style="flex: 1" @keyup.enter="addTag" />
        <el-color-picker v-model="newTag.color" />
        <el-button type="primary" @click="addTag">添加</el-button>
      </div>
      <ul class="tag-list">
        <li v-for="t in state.tags" :key="t.id">
          <i class="dot" :style="{ background: t.color }" />
          <span>{{ t.name }}</span>
          <span class="hint">
            {{ state.streamers.filter((s) => s.tags.includes(t.id)).length }} 个主播
          </span>
          <el-button link type="danger" size="small" @click="removeTag(t.id)">删除</el-button>
        </li>
      </ul>
      <div v-if="!state.tags.length" class="empty">还没有标签</div>
    </el-dialog>

    <!-- 编辑 -->
    <el-drawer v-model="editOpen" title="编辑主播" size="420px">
      <el-form label-width="86px" v-if="editing">
        <el-form-item label="平台">
          <span class="plat">
            <i class="dot" :style="{ background: platformColor(editing.platform) }" />
            {{ platformName(editing.platform) }} · {{ roomLabel(editing) }}
          </span>
        </el-form-item>
        <el-form-item label="显示名">
          <el-input v-model="editForm.name" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="editForm.remark" placeholder="例如：每天 20:00 开播" />
        </el-form-item>
        <el-form-item label="标签">
          <el-select v-model="editForm.tags" multiple style="width: 100%" placeholder="选择标签">
            <el-option v-for="t in state.tags" :key="t.id" :label="t.name" :value="t.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="清晰度">
          <el-select v-model="editForm.quality" clearable placeholder="跟随全局" style="width: 100%">
            <el-option v-for="q in state.meta?.qualities ?? []" :key="q" :label="q" :value="q" />
          </el-select>
        </el-form-item>
        <el-form-item label="单独目录">
          <div style="display: flex; gap: 6px; width: 100%">
            <el-input v-model="editForm.saveDir" placeholder="留空则用全局输出目录" />
            <el-button @click="pickSaveDir">选择</el-button>
          </div>
        </el-form-item>
        <el-form-item label="自动录制">
          <el-switch v-model="editForm.autoRecord" />
        </el-form-item>
        <el-form-item label="记录弹幕">
          <el-switch v-model="editForm.danmakuEnabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editOpen = false">取消</el-button>
        <el-button type="primary" @click="saveEdit">保存</el-button>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.global-warn {
  margin-bottom: 10px;
  flex: 0 0 auto;
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

.add-bar,
.filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
  flex: 0 0 auto;
}
.add-bar {
  flex-wrap: wrap;
}

.table-wrap {
  flex: 1 1 auto;
  min-height: 0;
  padding: 4px;
  overflow: hidden;
}
/* 操作列：按钮强制一行不换行，「移除」就不会被挤到「录制」正下方 */
:deep(.ops-col) .cell {
  white-space: nowrap;
  overflow: visible;
}
:deep(.ops-col) .cell .el-button + .el-button {
  margin-left: 6px;
}
/* 「移除」与前面的常规操作之间留出更大间隔，视觉上独立、降低误点 */
.remove-btn {
  margin-left: 14px !important;
}

.plat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.nm-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
}
.nm-row1 {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
.nm-row2 {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  flex-wrap: wrap;
}
.nm {
  font-weight: 600;
  flex: 1 1 auto;
  min-width: 0;
  /* 关键：名字完整显示，超出宽度自动换行，不再截断成省略号 */
  white-space: normal;
  word-break: break-word;
  line-height: 1.35;
}
/* 主播列单元格：允许换行、不裁切，名字过长时整行自适应高度完整显示 */
:deep(.col-name) .cell {
  white-space: normal !important;
  overflow: visible !important;
  word-break: break-word;
  overflow-wrap: anywhere;
  line-height: 1.4;
}
.remark {
  color: var(--ink-3);
  font-size: 12.5px;
}
.rid {
  color: var(--ink-4);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.cell-live {
  margin-left: 8px;
  font-size: 11.5px;
  color: var(--zhu);
  text-decoration: none;
  border: 1px solid var(--zhu);
  border-radius: 3px;
  padding: 0 5px;
  line-height: 16px;
  white-space: nowrap;
}
.cell-live:hover {
  background: var(--zhu);
  color: #fff;
}
/* 待开播：还没直播间号，别露出 sec: 占位符 */
.rid-pending {
  font-size: 11.5px;
  color: var(--jin);
  border: 1px dashed var(--jin);
  border-radius: 3px;
  padding: 0 5px;
  line-height: 16px;
  white-space: nowrap;
}
.title-cell {
  color: var(--ink-3);
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag {
  display: inline-block;
  padding: 0 6px;
  border-radius: 3px;
  font-size: 12px;
  margin-right: 4px;
  line-height: 17px;
}
.hint.tiny {
  font-size: 11.5px;
}
.top-mark {
  color: var(--jin);
}
.dim {
  color: var(--ink-4);
}

.tag-add {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.tag-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.tag-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px dashed var(--line);
}
.tag-list li .hint {
  margin-left: auto;
}

/* ---------------------------------------------------- 搜索主播对话框 */
.search-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.search-tip {
  margin: 8px 0;
}
.cookie-warn {
  margin-bottom: 8px;
}
.cookie-warn-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cookie-actions {
  display: flex;
  gap: 8px;
}
.search-err {
  color: var(--zhu);
  font-size: 13px;
  padding: 6px 0;
}
.search-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  max-height: 380px;
  overflow-y: auto;
}
.search-list li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 8px;
  border-bottom: 1px dashed var(--line);
}
.search-list li:last-child {
  border-bottom: none;
}
.avatar {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  object-fit: cover;
  flex: 0 0 auto;
  background: var(--paper-3);
}
.avatar-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-serif);
  font-size: 17px;
  color: var(--ink-3);
}
.search-list .meta {
  flex: 1 1 auto;
  min-width: 0;
}
.search-list .line1 {
  display: flex;
  align-items: center;
  gap: 8px;
}
.search-list .nm {
  font-weight: 600;
  font-size: 14px;
}
.search-list .dyid {
  color: var(--ink-4);
}
.search-list .line2 {
  display: flex;
  gap: 10px;
  margin-top: 2px;
  overflow: hidden;
  white-space: nowrap;
}
.search-list .sig {
  overflow: hidden;
  text-overflow: ellipsis;
}
.search-list .ops {
  flex: 0 0 auto;
  display: flex;
  gap: 6px;
}

/* ---- 导入我的关注 ---- */
.follow-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 0 6px;
}
.follow-list {
  max-height: 360px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--paper-2);
  min-height: 80px;
}
.follow-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px dashed var(--line);
}
.follow-row:last-child {
  border-bottom: none;
}
.follow-row .avatar {
  width: 36px;
  height: 36px;
}
.follow-check {
  flex: 0 0 auto;
}
.follow-list .meta {
  flex: 1 1 auto;
  min-width: 0;
}
.follow-list .line1 {
  display: flex;
  align-items: center;
  gap: 8px;
}
.follow-list .nm {
  font-weight: 600;
  font-size: 14px;
}
.follow-list .dyid {
  color: var(--ink-4);
  font-size: 12.5px;
}
.follow-list .line2 {
  display: flex;
  gap: 10px;
  margin-top: 2px;
  overflow: hidden;
  white-space: nowrap;
  font-size: 12.5px;
}
.follow-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.follow-foot .hint {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
