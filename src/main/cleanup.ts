/**
 * 便携版（portable 单文件）临时残留的处理。
 *
 * ── 一次启动到底在磁盘上发生了什么（读模板 + 逐秒实测）──
 * portable 版本质是 NSIS 自解压器。模板见
 * node_modules/app-builder-lib/templates/nsis/portable.nsi 与 include/extractAppPackage.nsh：
 *
 *   $PLUGINSDIR = %TEMP%\nsXXXXX.tmp     ← 每次启动随机一个新名字，长度还会变
 *   ┌ t=0~1s    File /oname=$PLUGINSDIR\app-64.7z       载荷（128.2 MB）+ 插件 dll
 *   ├ t=1~20s   Nsis7z::Extract → $PLUGINSDIR\7z-out    解压中间产物（约 566 MB）
 *   ├           CopyFiles /SILENT → $INSTDIR            复制成运行目录（约 566 MB）
 *   ├ t≈21s~   7z-out 解压完、复制到 $INSTDIR（NSIS 自己从不删 → 靠应用开机自清，见 ①）
 *   ├ t≈27s+    ExecWait "$INSTDIR\Xxx.exe"             应用从这里启动
 *   └           退出后 SetOutPath $EXEDIR；RMDir /r $INSTDIR；$PLUGINSDIR 由 NSIS 自身清理
 *
 *   $INSTDIR = %TEMP%\<ksuid>   ← 打包时 generateKsuid() 定死（NsisTarget.js:246-248），
 *                                 **同一份 exe 每次启动都用同一个名字**
 *
 * 逐秒实测（_plug3.txt）：
 *   t=2..19s  entries=4  [7z-out, app-64.7z, nsis7z.dll, System.dll]              128.4 MB
 *   t=21..25s entries=3  [app-64.7z, nsis7z.dll, System.dll]                      128.4 MB
 *   t=27s+    entries=4  [app-64.7z, nsis7z.dll, StdUtils.dll, System.dll]        128.5 MB
 *                         ↑ StdUtils.dll 是 portable.nsi:80 调 StdUtils 时长出来的
 * 但**这个窗口不是固定的**：另一次实测（_acc5.txt，Phase B）在 t=37s 时 7z-out 仍然
 * 满满当当，整目录 694.6 MB。也就是说启动器可能长时间停在「解压 / 拷贝」阶段，
 * 而且它是 `SetSilent silent`、**界面上完全看不出在干活** —— 用户很容易以为卡死而强杀。
 *
 * ── 为什么强杀会留下「这么大的文件」──
 *   1) 那 128 MB 的 `app-64.7z` 被放进了 `$PLUGINSDIR`，而 **它的名字每次启动都不一样**
 *      （NSIS 随机名），所以下一份 exe 启动时**认不出、也用不上**上一份的目录；
 *   2) `$PLUGINSDIR` 只由 NSIS 在**正常退出**时清理 —— 被强杀就永远留在 %TEMP% 里；
 *   3) 停在解压阶段被杀，同一目录里还多一份 `7z-out`，一次就是 **695 MB**。
 * 实测证据：本机 %TEMP% 里躺了 7 个 ns*.tmp × 128.5 MB ≈ 900 MB，全是强杀留下的。
 * 另一份 `$INSTDIR`（约 566 MB）本可由「同一份 exe 下次启动」自己回收
 * （portable.nsi:38 与 :90 各一次 `RMDir /r $INSTDIR`），但**换了新版 exe，ksuid 就变了**，
 * 旧的那份再也没人认领（实测留了个 234.8 MB 的残骸）。
 *
 * ── 为什么不能靠改 NSIS 脚本治本 ──
 * NsisTarget.js:595：自定义 `nsis.include` 那段被 `if (!this.isPortable)` 包住，
 * **portable 目标没有任何注入自定义 NSIS 脚本的口子**。NsisTarget.js:246 那条
 * `$INSTDIR = $PLUGINSDIR\app` 的分支（要给 unpackDirName 传 false 才会走）在代码里也走不到。
 * 于是「让启动器自己打标记 / 自己清」这条路是死的。
 *
 * ── 于是本模块干两件事 ──
 *   ① **当场清掉自己那一份的载荷 + 解压目录**（releaseOwnPluginsDir）。这是治本的一招：
 *      t≈27s 应用起来时，NSIS 已经 park 在 portable.nsi:86 的 ExecWait 上，
 *      `app-64.7z` 早被 Nsis7z 读完、`7z-out` 也早已复制到 $INSTDIR 当副本 —— 两者都冗余。
 *      把它们（连同那几个插件 dll）直接删掉，之后再被强杀，留下的只是一个**空目录**，
 *      而不是 128 MB 载荷 + 566 MB 解压目录。
 *   ② **回收历史残留**（sweepPortableTemp）。认领规则见下，认不出的一律不碰。
 *
 * ── 怎么证明一个临时目录是「我们的」（这是本模块的核心）──
 * 直接搜内容是不行的，实测过：7z 把文件清单 LZMA 压缩在头部，
 * 对 8 份真实载荷全文件扫描（_needle2.js），`funasr_runner.py` / `LiveReview.exe` /
 * `app.asar` 一个都搜不到（hits=NONE）。目录名也是随机的。所以：
 *
 *   ★ 载荷自证（最硬的证据）★
 *     `extractAppPackage.nsh:2-13` 在 File 指令前后做了 `SetCompress off`，
 *     所以那份 `app-64.7z` 是**原样**躺在便携 exe 里的。实测（_embed.txt）：
 *       便携 exe 尺寸 134567635，7z 签名在偏移 71490，
 *       NextHeaderOffset=134208078 NextHeaderSize=37 → 载荷长度 134208147，
 *       与残留目录里的 app-64.7z **逐字节相同**（SHA-256 一致）。
 *     于是：从 `PORTABLE_EXECUTABLE_FILE` 取启动器 exe，读出自己那份载荷的
 *     偏移与长度，再拿残留目录里的 app-64.7z 对尺寸 + 首尾采样哈希 —— 完全一致才认领。
 *     这既覆盖「只剩载荷」的窗口，又**不可能误判成别家应用**。
 *
 *   辅以三条老规则：
 *   1. 目录名以 .lr-del 结尾      —— 我们改名留下的，一定是我们
 *   2. 含标记文件 .livereview-owner —— 我们自己写进去的
 *   3. 含本应用独有文件 resources\funasr_runner.py / app.asar / LiveReview.exe
 *      （覆盖「解压中就被杀、7z-out 还在」和「旧 ksuid 运行目录」两种情况）
 *
 * ── 安全边界 ──
 *   - 绝不碰本实例自己所在的目录（process.execPath 在其下）
 *   - 绝不碰本实例自己的 $PLUGINSDIR（路径记在 ownPluginsDir 里，无条件跳过）
 *   - 年龄门槛（MIN_AGE_MS）：刚创建的一律放过，兜住「并发的另一个实例」
 *   - 含 LiveReview-Data 的一律不动（那是用户自己留着的绿色版，删了就是删他的数据）
 *   - **先改名、改名成功才删**。运行中的实例其文件被独占，改名必然失败 → 直接放过
 *     （实测这条真的会拦住东西：两个被 LiveReview.exe 占着的旧 ksuid 目录就被拦下了）
 *   - 删不掉就把名字改回去，不在 %TEMP% 里留 .lr-del 怪名字
 *   - 跨版本残留认不出就留着 —— 宁可多占点地方，也不误删
 *
 * ── 性能与耗时纪律（踩过大坑，务必保持）──
 * 一趟遍历 %TEMP% 要碰 5 万+ 目录项，**绝不能同步卡住主进程**：
 *   a) 目录之间 `await` 让出事件循环 —— 否则窗口挂起、冒烟钩子的退出计时器被推迟
 *   b) 删除走 `fsp.rm`（异步）+ 极小退避。**不要**用 `fs.rmSync(..., {maxRetries:30})`：
 *      rimraf 退避 250ms×(1+2+…+30) ≈ 116 秒且**全同步**，实测把主进程冻了 126 秒
 *   c) **整趟有墙钟死线 SWEEP_DEADLINE_MS**：删除在 EPERM/EBUSY 下反复重试时，
 *      光靠 maxRetries 并不能保证总耗时上界（实测出现单次 sweep 180 秒），
 *      所以必须有硬性截止，到点就收工、把没做完的留给下一次启动
 *   d) 遍历有 DIRENT 预算，防止 %TEMP% 里出现 junction 环之类的病态结构
 *   e) 载荷自证只在**找到候选之后**才做（先比尺寸，再算采样哈希），
 *      而且结果缓存 —— 一轮里最多读几 MB，不会把 128 MB 反复读
 *
 * 另注：宿主环境若通过 `NODE_OPTIONS=--require=...shim` 注入了 fs 拦截器（本机 WorkBuddy
 * 宿主就是这样，且只在 **Process** 作用域，注册表里没有），任何子进程里的 `fs.rm*`
 * 甚至 `fs.rename*` 都会被拦成 EPERM/EBUSY —— 排查时先查 `$env:NODE_OPTIONS`，
 * 别把它当成应用自己的 bug。打包/测试前记得 `Remove-Item Env:\NODE_OPTIONS`。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { log } from './logger'

const L = log('cleanup')

/** 进程启动时刻（模块加载 ≈ 主进程启动），用于认领「本实例刚创建的那份 $PLUGINSDIR」 */
const PROCESS_START_MS = Date.now()

/** 打包进 exe 的应用主程序名（= productName） */
const APP_EXE = 'LiveReview.exe'
/** 便携版会在 exe 同级建的数据目录；有它就说明是用户在用的绿色版 */
const DATA_DIR_NAME = 'LiveReview-Data'
/** 本应用独有的资源文件（extraResources 带进来的），藏在 resources\ 里，最抗删 */
const MARKER_FILES = ['funasr_runner.py', 'app.asar']
/** 我们给待删目录改的后缀：改过名 = 确认是我们的，后续轮次只认这个后缀也能收尾 */
const DEL_SUFFIX = '.lr-del'
/** 我们自己写进 $PLUGINSDIR 的标记文件（$PLUGINSDIR 里没有别的东西可当指纹） */
const OWNER_MARKER = '.livereview-owner'
/** NSIS 载荷文件名（electron-builder 的默认值） */
const PAYLOAD = 'app-64.7z'
/** 7z 文件签名 —— 用它在我们自己的便携 exe 里定位那份载荷 */
const SEVEN_Z_SIG = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
/** 在 exe 开头多大范围内找 7z 签名（实测偏移 71490，2 MB 足够宽松） */
const SIG_SCAN_SPAN = 2 * 1024 * 1024
/** 载荷自证的采样：首 64 KB + 尾 4 MB 足够定性，免得反复读 128 MB */
const PROOF_HEAD = 64 * 1024
const PROOF_TAIL = 4 * 1024 * 1024
/** 自家 $PLUGINSDIR 里可以安全删掉的东西：载荷本体 + NSIS 插件 dll */
const RELEASABLE_PAYLOADS = [
  'app-64.7z',
  'app-32.7z',
  'app-arm64.7z',
  'app-64.zip',
  'app-32.zip',
  'app-arm64.zip'
]
const RELEASABLE_DLLS = ['nsis7z.dll', 'nsisunz.dll', 'System.dll', 'StdUtils.dll']
/** 认领自己那份 $PLUGINSDIR 的时间窗：目录改动时间必须落在本进程启动前后这么久内 */
const OWN_WINDOW_MS = 5 * 60 * 1000
/** 年龄门槛：刚创建的目录一律放过（兜住「没标上记号的自己 / 并发实例」） */
const MIN_AGE_MS = 2 * 60 * 1000
/** 一趟遍历的目录项总预算（实测整趟约 5.5 万，留足余量） */
const DIRENT_BUDGET = 200_000
/** 整趟墙钟死线：到点就收工，剩下的留给下次启动，绝不拖住应用 */
const SWEEP_DEADLINE_MS = 20_000
/** 删失败后的整轮重试节流 */
const RETRY_DELAY_MS = 60_000
const MAX_ATTEMPTS = 3
/** 单次删除的重试：rimraf 退避 100+200 ≈ 0.3 s，且是异步的 */
const RM_MAX_RETRIES = 1
const RM_RETRY_DELAY_MS = 100

export interface SweepItem {
  path: string
  mb: number
  ms: number
}

export interface SweepResult {
  scanned: number
  cleaned: SweepItem[]
  skipped: { path: string; reason: string }[]
  freedBytes: number
  /// 本实例自己的 $PLUGINSDIR（认出来就有值），供日志与自检
  ownPluginsDir: string | null
  /// 是否因为到点而提前收工
  timedOut: boolean
  /// 当场从自家 $PLUGINSDIR 里清掉的载荷字节数（治本那一招的成果）
  releasedBytes: number
  /// 自家 $PLUGINSDIR 是否连目录本身都清掉了
  releasedDir: boolean
  /// 本实例是否成功从便携 exe 里解析出了「自己那份载荷」的指纹
  selfPayloadVerified: boolean
}

/** 让出事件循环，别把主进程按住 */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

/** child 是否位于 parent 之内（含自身） */
function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  if (!rel) return true
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** NSIS 的 $PLUGINSDIR 形状：ns + 随机 + .tmp（长度不定，所以不写死位数） */
const isPluginsDirName = (name: string): boolean => /^ns.+\.tmp$/i.test(name)

/** 读文件的一段（越界自动收敛），读不到返回空 buffer */
function readSlice(file: string, start: number, len: number): Buffer {
  if (len <= 0) return Buffer.alloc(0)
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.allocUnsafe(len)
      const n = fs.readSync(fd, buf, 0, len, start)
      return buf.subarray(0, n)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return Buffer.alloc(0)
  }
}

interface SelfPayload {
  file: string
  offset: number
  len: number
  fingerprint: string
}

let selfPayloadCache: SelfPayload | null | undefined

/**
 * 解析「我们自己那份载荷」在便携 exe 里的位置与指纹。
 *
 * 依据：`extractAppPackage.nsh` 在写 `app-64.7z` 的 File 指令前后 `SetCompress off`，
 * 所以载荷是**原样**存在 exe 里的 —— 拿 7z 签名定位，再用 start header 里的
 * NextHeaderOffset/NextHeaderSize 算出精确长度（实测 134208147，与残留目录里的
 * app-64.7z 逐字节相同）。
 *
 * 只有便携版才有这份东西：启动器路径在 `PORTABLE_EXECUTABLE_FILE`
 * （process.execPath 指向的是解压出来的那份副本，不是用户手里的 exe）。
 */
function resolveSelfPayload(): SelfPayload | null {
  if (selfPayloadCache !== undefined) return selfPayloadCache
  selfPayloadCache = null

  try {
    const file = process.env.PORTABLE_EXECUTABLE_FILE
    if (!file || !fs.existsSync(file)) return null

    const total = fs.statSync(file).size
    const probe = readSlice(file, 0, Math.min(SIG_SCAN_SPAN, total))
    const at = probe.indexOf(SEVEN_Z_SIG)
    if (at < 0 || at + 32 > probe.length) return null

    const nextOff = Number(probe.readBigUInt64LE(at + 12))
    const nextSize = Number(probe.readBigUInt64LE(at + 20))
    const len = 32 + nextOff + nextSize
    if (!Number.isSafeInteger(len) || len < 1024 * 1024 || at + len > total) return null

    const fingerprint = sliceFingerprint(file, at, len)
    if (!fingerprint) return null

    selfPayloadCache = { file, offset: at, len, fingerprint }
    L.info(
      `已从便携 exe 解析出自身载荷：offset=${at} len=${len}（` +
        `${(len / 1048576).toFixed(1)} MB）`
    )
  } catch (e) {
    L.warn('解析自身载荷失败（只影响残留回收，不影响使用）', String(e))
  }
  return selfPayloadCache
}

/** 某段区间的采样指纹：首 64 KB + 尾 4 MB 的 SHA-256 */
function sliceFingerprint(file: string, offset: number, len: number): string | null {
  try {
    const headLen = Math.min(PROOF_HEAD, len)
    const tailLen = Math.min(PROOF_TAIL, len)
    const head = readSlice(file, offset, headLen)
    const tail = readSlice(file, offset + len - tailLen, tailLen)
    if (head.length !== headLen || tail.length !== tailLen) return null
    return createHash('sha256').update(head).update(tail).digest('hex')
  } catch {
    return null
  }
}

/**
 * 这个 `app-64.7z` 是不是**我们自己这份 exe** 里的那份载荷？
 * 先比长度（省掉绝大多数无谓读取），长度相等再比采样指纹。
 * 这是我们能拿到的**最硬**的证据，也正因为验的是内容，不可能误判别家应用。
 */
function payloadIsOurs(payloadPath: string): boolean {
  const self = resolveSelfPayload()
  if (!self) return false
  let size = 0
  try {
    size = fs.statSync(payloadPath).size
  } catch {
    return false
  }
  if (size !== self.len) return false
  const fp = sliceFingerprint(payloadPath, 0, size)
  return fp !== null && fp === self.fingerprint
}

interface Budget {
  left: number
}

/** 在目录里按文件名找（大小写不敏感），浅层优先；受预算约束 */
function findFile(dir: string, name: string, maxDepth: number, b: Budget): string | null {
  const target = name.toLowerCase()
  const stack: { d: string; n: number }[] = [{ d: dir, n: 0 }]
  while (stack.length) {
    if (b.left <= 0) return null
    const cur = stack.pop() as { d: string; n: number }
    let list: fs.Dirent[]
    try {
      list = fs.readdirSync(cur.d, { withFileTypes: true })
    } catch {
      continue
    }
    b.left -= list.length
    for (const e of list) {
      const p = path.join(cur.d, e.name)
      if (e.isFile() && e.name.toLowerCase() === target) return p
      if (e.isDirectory() && cur.n < maxDepth) stack.push({ d: p, n: cur.n + 1 })
    }
  }
  return null
}

/**
 * 活锁探测：给目录改个名试试。
 *
 * Windows 上有打开句柄的目录（正在运行的实例、正在解压的进程）改名会失败
 * （「文件夹或其中的文件已在另一个程序中打开」/「访问被拒绝」），改名成功就说明没人占着它。
 * 实测这条真的会拦住东西：两个被 LiveReview.exe 占着的旧 $INSTDIR 就被拦下了。
 *
 * 不用 `fs.open(f,'r+')` 之类的写权限探测 —— 只读属性的文件（Electron 解出来
 * 的部分资源就是这样）同样会 EACCES，会被误判成「正在运行」而永远跳过。
 */
function tryRename(dir: string, to: string): boolean {
  try {
    fs.renameSync(dir, to)
    return true
  } catch {
    return false
  }
}

/** 目录体积，用于日志；受预算约束，超预算就返回已累计值 */
function dirSize(dir: string, b: Budget): number {
  let total = 0
  const stack: string[] = [dir]
  while (stack.length) {
    if (b.left <= 0) break
    const cur = stack.pop() as string
    let list: fs.Dirent[]
    try {
      list = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    b.left -= list.length
    for (const e of list) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size
        } catch {
          /* 读不到就不计入 */
        }
      }
    }
  }
  return total
}

/**
 * 认出本实例自己的 `$PLUGINSDIR`。
 *
 * 候选 = `%TEMP%\ns*.tmp` 形状 且 里面的 `app-64.7z` **经载荷自证确认就是本 exe 里那份**。
 * 在候选里取「目录改动时间离本进程启动最近」的那个 —— 同一次启动产生的那份必然刚刚才动过
 * （实测最后一次动它是 portable.nsi:80 落 StdUtils.dll，距主进程启动只有 1~3 秒），
 * 而历史残留会老出几十秒到几小时，所以这一段距离能把两者干净地分开。
 *
 * 因为候选是靠**内容**认出来的，这里不需要「候选必须唯一」这种保守退让。
 */
function markOwnPluginsDir(): string | null {
  // 不是便携版（zip / win-unpacked）就没有 $PLUGINSDIR 可言
  if (!resolveSelfPayload()) return null

  const tmp = os.tmpdir()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(tmp, { withFileTypes: true })
  } catch {
    return null
  }

  let best: { dir: string; delta: number } | null = null
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (!isPluginsDirName(e.name)) continue
    const dir = path.join(tmp, e.name)
    // 本实例就住在里面时，那就是自己，直接认定
    if (isUnder(process.execPath, dir)) return dir

    const payload = path.join(dir, PAYLOAD)
    if (!fs.existsSync(payload)) continue
    if (!payloadIsOurs(payload)) continue

    let m = 0
    try {
      m = fs.statSync(dir).mtimeMs
    } catch {
      continue
    }
    const delta = Math.abs(m - PROCESS_START_MS)
    if (delta > OWN_WINDOW_MS) continue
    if (!best || delta < best.delta) best = { dir, delta }
  }

  if (!best) return null
  const dir = best.dir
  try {
    fs.writeFileSync(
      path.join(dir, OWNER_MARKER),
      `LiveReview portable temp dir\nwritten=${new Date().toISOString()}\npid=${process.pid}\n`,
      'utf8'
    )
    L.info(`已给自己的临时目录打标记 ${dir}`)
  } catch (e) {
    L.warn('打标记失败（不影响使用）', String(e))
  }
  return dir
}

/**
 * **治本**：把自己那份 `$PLUGINSDIR` 里已经没用的东西清掉。
 *
 * 依据（已核对 portable.nsi）：t≈27s 应用被 ExecWait 拉起来时，NSIS 停在 :86 不再动，
 * `app-64.7z` 已被 Nsis7z 读完，StdUtils 的参数 (:80) 也早取完了；`7z-out` 早已被复制到
 * $INSTDIR（extractAppPackage.nsh:108）本份纯冗余。**app-64.7z 与 7z-out 都删掉**，
 * 之后再被强杀，%TEMP% 里只剩一个空目录，而不是 128 MB 载荷 + 566 MB 解压目录。
 *
 * 只删白名单里的文件，绝不 `RMDir /r` 整个目录（万一里面还有别的进程的东西）。
 * dll 有可能被 NSIS 短暂持有，删不掉就算了，不影响。
 */
function releaseOwnPluginsDir(dir: string): { bytes: number; files: number; dirRemoved: boolean } {
  let bytes = 0
  let files = 0
  for (const name of [...RELEASABLE_PAYLOADS, ...RELEASABLE_DLLS]) {
    const p = path.join(dir, name)
    try {
      const st = fs.statSync(p)
      if (!st.isFile()) continue
      fs.unlinkSync(p)
      bytes += st.size
      files++
    } catch {
      /* 不在 / 删不掉：都无所谓 */
    }
  }
  // 解压中间目录 7z-out：与载荷同级（extractAppPackage.nsh:94 建在 $PLUGINSDIR），
  // 复制到 $INSTDIR 后 NSIS 自己从不删它（只靠正常退出清），应用启动后它纯属冗余。
  // 不删它，强杀后就是 566 MB 的大残留 —— 正是用户抱怨「为啥留下这么大的文件」。
  // 应用从 $INSTDIR 的副本运行，7z-out 删掉绝对安全。
  const sevenOut = path.join(dir, '7z-out')
  if (fs.existsSync(sevenOut)) {
    try {
      fs.rmSync(sevenOut, {
        recursive: true,
        force: true,
        maxRetries: RM_MAX_RETRIES,
        retryDelay: RM_RETRY_DELAY_MS
      })
      files++
    } catch {
      /* 被杀软/索引器短暂占用 → 留给下一轮 sweep 按标记认领 */
    }
  }
  let dirRemoved = false
  if (files > 0) {
    try {
      fs.rmdirSync(dir)
      dirRemoved = true
    } catch {
      /* 还有东西留着（或正被占用）→ 让 sweep 按标记去认领 */
    }
    L.info(
      `已清掉自家临时目录里的载荷 ${files} 个文件 ${(bytes / 1048576).toFixed(0)} MB` +
        (dirRemoved ? '，目录一并清掉' : '')
    )
  }
  return { bytes, files, dirRemoved }
}

/** 按内容/标记判断这是不是本应用留下的临时目录；认不出就返回 false（等于放过） */
function classify(dir: string, b: Budget): boolean {
  // 我们改过名的（上一轮删了一半，指纹可能已经不全）——一定是我们
  if (dir.endsWith(DEL_SUFFIX)) return true
  // 我们启动时自己写进去的标记——最可靠
  if (fs.existsSync(path.join(dir, OWNER_MARKER))) return true
  // 应用独有资源：藏在 resources\ 里，比顶层文件抗删
  for (const m of MARKER_FILES) if (findFile(dir, m, 3, b)) return true
  if (fs.existsSync(path.join(dir, APP_EXE)) || findFile(dir, APP_EXE, 3, b) !== null) return true
  // 「7z-out 已清掉、只剩载荷」的窗口：靠载荷自证（尺寸 + 采样哈希）
  if (isPluginsDirName(path.basename(dir))) {
    const payload = path.join(dir, PAYLOAD)
    if (fs.existsSync(payload) && payloadIsOurs(payload)) return true
  }
  return false
}

/** 跑一轮回收。全程异步、目录间让出事件循环、遍历与耗时都有硬上界。 */
export async function sweepPortableTemp(): Promise<SweepResult> {
  const res: SweepResult = {
    scanned: 0,
    cleaned: [],
    skipped: [],
    freedBytes: 0,
    ownPluginsDir: null,
    timedOut: false,
    releasedBytes: 0,
    releasedDir: false,
    selfPayloadVerified: resolveSelfPayload() !== null
  }
  const b: Budget = { left: DIRENT_BUDGET }
  const tStart = Date.now()

  // 先给自己那份打标记、再当场清掉它的载荷：
  // 顺序很重要 —— 万一在「清」的过程中被强杀，留下的目录也已经有标记，下次一定认得出。
  res.ownPluginsDir = markOwnPluginsDir()
  if (res.ownPluginsDir) {
    const rel = releaseOwnPluginsDir(res.ownPluginsDir)
    res.releasedBytes = rel.bytes
    res.releasedDir = rel.dirRemoved
    // 目录都清掉了：没什么可保护的，也不该再去碰它
    if (rel.dirRemoved) res.ownPluginsDir = null
  }

  const tmp = os.tmpdir()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(tmp, { withFileTypes: true })
  } catch (e) {
    L.warn('读不到临时目录，跳过回收', String(e))
    return res
  }

  for (const e of entries) {
    // 每个候选之间让出事件循环：窗口别被按住，退出计时器也别被推迟
    await tick()

    if (Date.now() - tStart > SWEEP_DEADLINE_MS) {
      res.timedOut = true
      L.warn(`回收超过 ${SWEEP_DEADLINE_MS / 1000} 秒，本轮收工，剩下的下次启动再收`)
      break
    }
    if (b.left <= 0) {
      L.warn('遍历预算用尽，本轮提前结束')
      break
    }
    if (!e.isDirectory()) continue

    const dir = path.join(tmp, e.name)

    // 本实例就住在里面时绝不碰
    if (isUnder(process.execPath, dir)) {
      res.scanned++
      res.skipped.push({ path: dir, reason: '本实例正在使用' })
      continue
    }
    // 本实例自己的 $PLUGINSDIR 也绝不碰（它就在隔壁，名字随机、内容与残留极像）
    if (res.ownPluginsDir && dir === res.ownPluginsDir) {
      res.scanned++
      res.skipped.push({ path: dir, reason: '本实例自己的临时目录' })
      continue
    }

    if (!classify(dir, b)) continue

    // 年龄门槛：刚创建的一律放过（兜住并发运行的另一个实例）
    let mtime = 0
    try {
      mtime = fs.statSync(dir).mtimeMs
    } catch {
      continue
    }
    if (Date.now() - mtime < MIN_AGE_MS) {
      res.skipped.push({ path: dir, reason: '刚创建（可能是别的实例正在使用）' })
      continue
    }

    res.scanned++

    // 用户在用的绿色版：数据目录在里面，删了就是删他的数据
    if (fs.existsSync(path.join(dir, DATA_DIR_NAME))) {
      res.skipped.push({ path: dir, reason: `含 ${DATA_DIR_NAME}，像是在用的绿色版` })
      continue
    }

    // 先改名：改名成功 = 没有进程占着它，可以放心删；
    // 改名失败（正在运行的实例 / 正在解压 / 被保护）→ 直接放过，绝不去动里面的文件
    let target = dir
    if (!dir.endsWith(DEL_SUFFIX)) {
      const renamed = `${dir}${DEL_SUFFIX}`
      if (!tryRename(dir, renamed)) {
        res.skipped.push({ path: dir, reason: '改名失败（有进程占用或受保护）' })
        continue
      }
      target = renamed
    }

    const t0 = Date.now()
    const bytes = dirSize(target, b)
    try {
      await fsp.rm(target, {
        recursive: true,
        force: true,
        maxRetries: RM_MAX_RETRIES,
        retryDelay: RM_RETRY_DELAY_MS
      })
      const ms = Date.now() - t0
      res.cleaned.push({ path: target, mb: bytes / 1048576, ms })
      res.freedBytes += bytes
      L.info(`回收 ${target}（${(bytes / 1048576).toFixed(0)} MB，${ms} ms）`)
    } catch (err) {
      const ms = Date.now() - t0
      // 删不掉就把名字改回去，不在 %TEMP% 里留 .lr-del 这种怪名字；
      // 改不回去也不要紧，下一轮按后缀照样认领
      if (target !== dir) {
        try {
          fs.renameSync(target, dir)
          target = dir
        } catch {
          /* 留着 .lr-del，下一轮再来 */
        }
      }
      res.skipped.push({
        path: target,
        reason: `删除失败（${ms} ms）：${(err as Error)?.message ?? err}`
      })
    }
  }

  return res
}

/** 启动后延迟跑一次；有删除失败就隔一分钟再试，最多 3 轮。不阻塞界面，失败只记日志 */
export function scheduleSweep(delayMs = 4000): void {
  const run = async (attempt: number): Promise<void> => {
    let r: SweepResult
    try {
      r = await sweepPortableTemp()
    } catch (e) {
      L.warn('临时目录回收失败（不影响使用）', String(e))
      return
    }

    if (attempt === 1) {
      L.info(
        `临时残留回收：本实例载荷自证=${r.selfPayloadVerified ? 'ok' : 'n/a'}，` +
          `当场清掉自家载荷 ${(r.releasedBytes / 1048576).toFixed(0)} MB` +
          (r.releasedDir ? '（连目录一起）' : '')
      )
    }
    if (r.cleaned.length) {
      L.info(
        `便携版遗留临时目录已回收 ${r.cleaned.length} 个，释放 ${(r.freedBytes / 1048576).toFixed(0)} MB`
      )
    }
    for (const s of r.skipped) L.info('跳过', s.path, s.reason)

    const failed = r.skipped.some((s) => s.reason.startsWith('删除失败'))
    if (failed && !r.timedOut && attempt < MAX_ATTEMPTS) {
      // 刚解压出来的几百 MB 二进制常被杀软/索引器短暂扫描，等一下再试
      L.info(`将在 ${RETRY_DELAY_MS / 1000} 秒后重试回收（第 ${attempt + 1} 次）`)
      const t = setTimeout(() => void run(attempt + 1), RETRY_DELAY_MS)
      t.unref?.()
    }
  }

  const timer = setTimeout(() => void run(1), delayMs)
  // 别因为这个定时器拖住退出
  timer.unref?.()
}
