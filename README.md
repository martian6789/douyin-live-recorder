# 直播复盘工具（LiveReview）

多平台直播录制 / 监控 / 弹幕归档 / 本地转写工具。
Electron 44 + electron-vite 5 + Vue 3.5 + TypeScript + Element Plus。

> **这个项目的由来**：我对市面上一款闭源直播复盘工具（`直播复盘工具pro` 1.3.0）做了静态审计，
> 发现它为了实现视频号录制，会在系统里 **安装自签根证书并接管全局 HTTPS 代理**（等于在机器上装了一个 MITM，
> 网银、聊天全在它眼皮底下）。**本项目刻意不做这件事**——
> 视频号改走「窗口/屏幕捕获 + 系统音频回环」，不碰证书、不改代理、不动 hosts。
> 其余功能（主播库 / 监控 / 录制 / 弹幕 / 录像库 / 转写 / 合并转码 / 通知 / 磁盘看护）按同等能力重建。

---

## 一、跑起来

```bash
npm install
npm run dev        # 开发模式（热更新）
npm run build      # 只构建，产物在 out/
npm run dist       # 打包 Windows 单文件便携版，产物在 dist/
npm run typecheck  # 主进程 + 渲染进程类型检查
```

### 打包产物（两种形态，同一次 `npm run dist` 一起出）

```
dist/LiveReview-0.1.1-portable.exe      # 单文件便携版（免安装，双击即用）
dist/LiveReview-0.1.1-x64.zip           # 绿色版（解压一次，直接跑里面的 exe）
```

**单文件便携版**
- **免安装**：不写注册表、不建开始菜单。
- 代价是**每次启动都要把自己解压一遍** —— 它是 NSIS 自解压器，一次启动在 `%TEMP%` 落两处：
  - ① `%TEMP%\nsXXXXX.tmp\`（= NSIS 的 `$PLUGINSDIR`，**每次启动随机一个新名字**，长度还会变）
    里先放内嵌载荷 `app-64.7z`（≈128 MB），再就地解开成 `7z-out\`（≈566 MB）当中间产物；
  - ② 复制到运行目录 `%TEMP%\<ksuid>\`（= `$INSTDIR`）。这个 ksuid 是**打包时**用
    `generateKsuid()` 生成的（`NsisTarget.js:246` 的 `unpackDirName || generateKsuid()`），
    所以**同一份 exe 每次启动都用同一个名字**；而启动脚本开头就有一句 `RMDir /r $INSTDIR`
    —— 上次强杀留下的运行目录，下次启动时会被自己删掉。
  - 于是**真正会永久堆积的只有 ①**：它每次换名，永远没人复用。一次强杀留下
    `app-64.7z`（≈128 MB）+ `7z-out\`（≈566 MB）≈ **约 695 MB**，杀几次堆几次。
    （② 虽然也有 ≈566 MB，但同一份 exe 再次启动时会自清 —— 前提是你还能再启动它。）
- 目录名两个都不可预测（一个随机长度可变、一个每次构建换新 ksuid），
  所以**清理不能靠名字匹配**，只能靠内容指纹 —— 见下。
  - **两道防线**（`src/main/cleanup.ts`），确保强杀不再留大文件：
    - ① **治本 —— 开机自清**：应用一旦被 `ExecWait` 拉起来，NSIS 已 park 在 `portable.nsi:86` 不再动，
      立刻把自己 `$PLUGINSDIR` 里的 `app-64.7z`（≈128 MB）**和** `7z-out\`（≈566 MB，
      已从它复制到运行目录当副本、纯冗余）连同几个插件 dll 一起删掉。之后再被强杀，`%TEMP%`
      里只剩一个空壳目录（≈0.1 MB），而不是 695 MB。
    - ② **回收历史残留**：上一轮被强杀、或杀在解压阶段来不及自清的目录，由下一次启动的
      sweep 认领删除。认领**不看目录名**（都不可靠），按「越抗删越优先」排：
      `*.lr-del` 后缀 → `resources\funasr_runner.py` / `app.asar` → `LiveReview.exe`；
      **「只剩 `app-64.7z`」这种窗口改用哈希认领** —— 因为 `extractAppPackage.nsh` 用
      `SetCompress off` 把载荷**原样**嵌在 exe 里，应用读出自己那份的偏移/长度并采样 SHA-256，
      与残留 `app-64.7z` 比对，**完全一致才认领**：既覆盖「只留载荷」的窗口，又不可能误删别家应用。
    安全边界：**先改名，改名成功才删** —— 运行中的实例其文件被独占，改名必然失败 → 直接放过，
    绝不会把正在跑的实例删坏；含 `LiveReview-Data` 的一律不动（那是你的绿色版数据）；
    删不掉（被杀软/索引器短暂占用，`EBUSY`）就把名字改回去或留作 `.lr-del`，下一轮再来。
    遍历保持异步、目录之间让出事件循环、**整趟有墙钟死线**，**不会卡住界面**也不会拖慢退出。
- **数据跟着 exe 走**：首次运行在 exe 同级建 `LiveReview-Data/`（配置与录像都在里面）。
  把 exe 和这个文件夹一起拷走，一切照旧；exe 所在目录不可写时自动退回 `%APPDATA%\live-review`。

**绿色版 zip（推荐长期使用）**
- 解压到任意位置，直接双击里面的 `LiveReview.exe`：**不落临时目录、秒启动、零残留**，
  数据同样在 exe 同级 `LiveReview-Data/`。
- 想升级就解压新包覆盖（`LiveReview-Data/` 不会被覆盖）。

> 已经内置 ffmpeg 9.0.2，目标机器不用装任何东西。ffprobe 没有内置 ——
> 它一个就 100 MB，而时长/分辨率 `ffmpeg -i` 自己就能给（`src/main/ffmpeg.ts` 里有兜底解析）。

改回安装版：把 `package.json` 里 `build.win.target` 换成 `nsis`（不要设 `portable.unpackDirName`，
理由见上：它既不省解压，还会让第二次启动把正在运行的实例的文件删掉）。

### ⚠️ 本机环境注意事项（踩过的坑）

1. **`ELECTRON_RUN_AS_NODE=1` 会让程序起不来。**
   Electron 会退化成纯 Node，`require('electron')` 返回的是 exe 路径字符串而不是 API 对象。
   运行前先清掉：`Remove-Item Env:\ELECTRON_RUN_AS_NODE`

2. **「双击没反应 / 一闪就退」= GPU 进程起不来**（已在代码里修掉，记录备查）。
   日志：`GPU process exited unexpectedly: exit_code=1` ×N → `FATAL: GPU process isn't usable. Goodbye.`，
   退出码 `-2147483645`。实测 `--disable-gpu` **治不了**，有效的是 `app.commandLine.appendSwitch('disable-gpu-sandbox')`
   （`src/main/index.ts` 启动时已自动追加），并默认关闭硬件加速。想要硬件加速设 `LR_GPU=1`。
   受限会话（远程桌面 / 无交互桌面）里尤其容易触发。

3. **ffmpeg**：探测顺序 = 用户指定 → 内置 `resources/ffmpeg.exe` → 系统 PATH。

4. **国内网络**：`.npmrc` 已指向 npmmirror。若 `node_modules/electron/dist` 缺失：
   ```powershell
   $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
   node node_modules/electron/install.js
   ```

5. **`npm run dist` 会额外联网下构件，裸连必炸。**
   electron-builder 除了 electron 本体，还会临时下载别的（实测有 `icons-bundle.tar.gz`），
   这些走它自己的下载器，**不吃 `.npmrc` 里的 mirror**。裸连的报错是
   `Client network socket disconnected before secure TLS connection was established`，
   运气差时表现为**十几分钟没有任何输出**（不是死锁，在等 TLS 超时）。
   打包前先设好代理与镜像：
   ```powershell
   $env:HTTP_PROXY  = "http://127.0.0.1:10808"
   $env:HTTPS_PROXY = "http://127.0.0.1:10808"
   $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
   $env:DEBUG = "electron-builder"   # 想看它到底在下什么就加上
   npm run dist
   ```

6. **打包时的两个操作纪律**（都踩过）：
   - **同一时刻只跑一个打包**。两次重叠会抢 `dist/win-unpacked*` 与 `*.lock`，
     表现成「解包到一半永久不动」。重打前先清 `win-unpacked.tmp`、`win-unpacked.tmp.lock`、半个 `*.nsis.7z`。
   - **`electron-builder` 单独跑不会重建 JS**，只打包 `out/`。改完源码直接 `electron-builder`
     会把旧代码打进去且**不报错**。用 `npm run dist`（它两件事都做），或先核一下
     `out/main/index.js` 与 `src/**` 的时间戳。
   - 最后一步 `7za -mx=9` 对 600 MB 做 LZMA 是**单核 4~5 分钟**，期间 `*.nsis.7z` 长期显示 0 MB，
     别误判成卡死（判据看 `Get-Process 7za` 的 CPU 时间是否在涨）。

7. **`win.icon` 用的是原版那枚图标**（`resources/icon.png`，256×256，从原版
   `直播复盘工具pro-1.3.0-setup.exe` 内提取）。仅作个人自用复刻的一致性对照，
   若要对外分发请自行替换。

### 冒烟自检

```powershell
$env:LR_SMOKE=1; npm run build; npx electron .
```
不弹窗，2.5 秒后打印 ffmpeg 状态、数据目录、preload 暴露的命名空间数量与渲染结果，写入数据目录的 `smoke.log` 后自动退出。

顺带验一下媒体探测链路（不依赖 ffprobe 的兜底解析）：

```powershell
$env:LR_SMOKE=1; $env:LR_PROBE="D:\某个视频.mp4"; npx electron .
# [probe] {"durationMs":3000,"vcodec":"h264","width":640,"height":360,"fps":30,"acodec":"aac",...}
```

---

## 二、目录结构

```
src/
├─ shared/                     主进程与渲染进程共用的「契约层」，三层都只依赖它
│  ├─ types.ts                 全部数据类型 + 平台/清晰度等常量
│  ├─ ipc.ts                   IPC 通道名 / 事件名（与原版命名对齐）
│  └─ api.ts                   window.api 的接口定义（preload 拿它自检）
├─ main/
│  ├─ index.ts                 入口：启动兜底开关、单实例、窗口、托盘、生命周期
│  ├─ ipc.ts                   唯一「配电盘」：把服务接到通道，并集中广播事件
│  ├─ logger.ts                按天轮转的文件日志
│  ├─ store.ts                 纯 JSON 持久化（配置/主播/标签/历史/凭据/任务）
│  ├─ template.ts              命名模板引擎（变量 / 渲染 / 校验 / 清洗）
│  ├─ ffmpeg.ts                定位 + 探测 + 各类命令行拼装 + 执行器
│  ├─ recorder.ts              录制引擎：拉流 → 落盘 → 弹幕 → 断流重连 → 写历史
│  ├─ monitor.ts               开播监控：单定时器轮询 + 指数退避 + 批量回写
│  ├─ danmaku.ts               弹幕落盘（JSONL + ASS）
│  ├─ danmaku-hub.ts           弹幕连接管理（一个房间一条连接）
│  ├─ streamers.ts             主播库业务规则：解析/去重/排序/标签/导入导出
│  ├─ merger.ts                分段合并（concat demuxer + -c copy）
│  ├─ converter.ts             批量转码 / 转封装
│  ├─ capture.ts               视频号捕获（gdigrab + dshow）
│  ├─ transcribe.ts            本地 FunASR 转写编排
│  ├─ library.ts               录像库扫描（只读）+ 回收站删除
│  ├─ disk.ts                  磁盘看护（提醒 / 停录 / 清理最旧）
│  ├─ notify.ts                通知分发（企业微信 / Webhook / 邮件）
│  ├─ relay.ts                 本地流中继（内置播放器用，解决 Referer 403）
│  └─ providers/               平台适配器
│     ├─ types.ts              LiveProvider 接口
│     ├─ http.ts               统一请求封装（UA / Referer / Cookie / 超时）
│     ├─ bilibili.ts  douyu.ts  huya.ts  douyin.ts  kuaishou.ts
│     └─ index.ts              平台注册表
├─ preload/index.ts            contextBridge 暴露 window.api（实现 shared/api.ts 契约）
├─ preload/index.d.ts          window.api 的全局类型声明
└─ renderer/                   Vue 3 + Element Plus
   ├─ App.vue                  外壳：标题栏 + 侧栏 + 内容区 + 状态栏 + 首启引导
   ├─ store.ts                 渲染进程全局状态（reactive，不引 pinia）
   ├─ format.ts                字节/时长/时间格式化
   ├─ style.css                设计令牌（暖纸底 / 深色）/ Element Plus 主题覆盖
   ├─ components/TitleBar.vue  自绘标题栏（窗口为 frame:false）
   └─ views/                   11 个功能页
      DashboardView   概览（统计卡 / 正在直播 / 最近录制 / 环境体检）
      MonitorView     开播监控（任务表 / 启动停止 / 立即检测）
      StreamersView   主播库（添加 / 批量 / 标签 / 排序 / 导入导出）
      RecordingView   录制中心（进行中任务 + 内置播放预览 + 实时弹幕）
      LibraryView     录像库（扫描 / 筛选 / 播放 / 定位 / 回收站删除）
      HistoryView     录制历史
      TranscribeView  本地转写（环境体检 / 批量 / 进度）
      ToolsView       分段合并 + 批量转码
      CaptureView     视频号捕获（窗口缩略图 / 音频设备 / 参数）
      SettingsView    设置（通用 / 模板 / 并发 / 磁盘 / 通知 / Cookie）
      AboutView       关于（环境 / 数据落点 / 与原版差异）
```

### 数据落点

| 模式 | 数据目录 |
|---|---|
| 便携版 | exe 同级 `LiveReview-Data/` |
| 开发模式 / exe 目录不可写 | `%APPDATA%/live-review/` |

全是纯 JSON，可直接备份或手工编辑：

```
config.json        应用配置（含磁盘看护、通知、捕获、转写设置）
streamers.json     主播库（含运行态：直播状态、最后检测时间…）
tags.json          标签
history.json       录制历史（最多 3000 条）
credentials.json   各平台 Cookie
jobs-*.json        转写/转码/合并的任务记录
logs/app-YYYY-MM-DD.log
recordings/        默认录像输出目录
```

录像默认按模板 `{platform}/{name}/{date}/{time}_{title}` 落盘，即
`recordings/bilibili/某主播/2026-09-20/203015_今晚八点开播.mp4`。

---

## 三、加一个新平台

**只改两处**，主进程与 UI 都不动：

1. `src/shared/types.ts` 的 `PlatformId` 加一项，并在 `PLATFORMS` 里补一行（名字/颜色/是否需 Cookie）。
2. 新建 `src/main/providers/xxx.ts` 实现 `LiveProvider`，然后在 `providers/index.ts` 注册一行。

```ts
export const xxxProvider: LiveProvider = {
  id: 'xxx',
  name: '新平台',
  danmakuSupported: false,
  parseRoomId: (input) => { /* 从 URL 或纯数字里抠出房间号 */ },
  getRoomInfo: async (roomId, ctx) => { /* 返回 RoomInfo */ },
  getStreams: async (roomId, ctx) => { /* 返回 StreamVariant[]，清晰度从高到低 */ },
  createDanmaku: () => { throw new NotImplementedError('弹幕') }
}
```

---

## 四、各平台现状（重要）

| 平台 | 房间信息 | 拉流 | 弹幕 | 备注 |
|---|---|---|---|---|
| 哔哩哔哩 | ✅ | ✅ | ✅ WebSocket | 最完整；清晰度走 `getRoomPlayInfo`，未带 Cookie 会自动补 buvid3 |
| 斗鱼 | ✅ `betard` | ✅ H5 接口 | ✅ TCP 689 | 弹幕协议已实现，未在真实直播间长时间验证 |
| 虎牙 | ✅ 页面解析 | ✅ 页面解析 | ❌ | 页面结构一变就要改正则；弹幕是私有 wss 协议 |
| 抖音 | ⚠️ | ⚠️ | ❌ | web 接口有风控，需完整 Cookie，部分接口还要 a_bogus 签名 |
| 快手 | ⚠️ | ⚠️ | ❌ | 需 Cookie，稳定性一般 |
| 微信视频号 | — | — | — | 无公开接口，走「捕获」模式录制（见下） |

**接口会变。** 某天某平台突然不可用时的排查顺序：
1. 「设置 → 平台 Cookie」补 Cookie（抖音/快手尤其依赖）；
2. 看提示的错误信息，对应 `getRoomInfo` / `getStreams` 抛出的原因；
3. 对着浏览器 F12 抓一次真实请求，修 provider 里的字段解析。

---

## 五、录制输出

单次录制在同一目录产出（同名不同后缀）：

- `xxx.mp4` —— 视频（`-c copy` 不重编码，CPU 占用极低）
- `xxx.danmaku.jsonl` —— 每行一条弹幕事件（全量，含时间戳与相对偏移）
- `xxx.danmaku.ass` —— 字幕，可直接挂进播放器看弹幕回放

开了分段就是 `xxx_000.mp4`、`xxx_001.mp4`…，弹幕仍写同一组文件；
「合并转码」页可把分段无损合成单文件，并把历史里的分段记录合并成一条。

**停止录制时向 ffmpeg 的 stdin 写 `q`** 让它优雅收尾（8 秒未退才强杀），
并用 `+frag_keyframe+empty_moov`，即使被强杀，已录部分仍可播放。

### 内置播放预览

各平台拉流地址都校验 Referer/UA，页面里的 `<video>` 改不了请求头，直连必然 403。
所以主进程在 `127.0.0.1` 起一个小中继（只放行白名单域名的流），带正确请求头取流再转给页面；
FLV 用 mpegts.js、HLS 用 hls.js 播放。

---

## 六、视频号捕获（与原版最大的差异）

原版：自签根证书 + 接管系统代理 → MITM 解密出真实流地址。
本项目：`ffmpeg -f gdigrab`（窗口/整屏） + `-f dshow`（系统音频回环），Compliance 上干净，效果等价（画质取决于窗口大小）。

- 录制时把视频号窗口保持在屏幕上可见（被完全遮挡的部分录不到内容）。
- 想只录画面区域，用「窗口」模式比整屏裁剪更清晰。
- 音频需要先在「声音设置 → 录制」启用「立体声混音」，否则下拉里选不到设备。

---

## 七、本地语音转写

不把音频传到云端，用本机 Python + FunASR（Paraformer）。

第一屏是**环境体检**：Python 有没有、funasr 装没装、模型下没下，按体检结果给出可点的修复动作。

流程：视频 →（ffmpeg 抽 16k 单声道 wav）→ `resources/funasr_runner.py` → srt / txt / vtt / json，
可选把字幕烧进视频。

---

## 八、明确不做的事

- **不做视频号的 MITM 抓取**：需要自签根证书 + 接管系统代理，能解密机器上所有 HTTPS（含网银），
  风险与法律问题都不划算。
- **不做激活 / 授权 / 加密壳**：不联作者服务器、没有会员卡密校验，代码全部明文，方便自己改。
- **不做云端 ASR / 云同步**：通知只走你填的 Webhook / 企业微信 / 自己的 SMTP。

---

## 九、后续可以加的方向

- 抖音弹幕：protobuf + `wss://webcast5-ws-web-hl.douyin.com/webcast/im/push/v2/`，
  需解析 PushFrame / ResponseFrame / ChatMessage 三层，建议用 `protobufjs`。
- 虎牙弹幕：私有 wss 协议（`wss://ws-apiext.huya.com`），需按 Tars 结构解码。
- 复盘检索：把 `*.danmaku.jsonl` 与转写文本灌进 SQLite FTS5，实现「哪一秒有人说了什么」的关键词定位。
- 剪辑导出：按弹幕高光（礼物/超级留言）自动生成切片清单。

---

## 十、本次交付验收记录

产物：`dist/LiveReview-0.1.0-portable.exe`
（版本 0.1.1 · x64 · 153.3 MB · 解压后 682 MB · 免安装单文件）

| 验收项 | 结果 |
|---|---|
| `tsc -p tsconfig.node.json` | ✅ exit 0 |
| `vue-tsc -p tsconfig.web.json` | ✅ exit 0 |
| `electron-vite build` | ✅ main 175 kB / preload 20 kB / renderer 主包 2.8 MB（+ hls 1.3 MB、mpegts 408 kB 分包） |
| 内层 exe 冒烟（`LR_SMOKE=1`） | ✅ exit 0；ffmpeg=bundled 9.0.2；preload api keys=**22**；rendered=**true**；无 GPU 错误、无 FATAL |
| 便携版连续启动 5 次 | ✅ **5/5**，窗口标题「直播复盘工具」，退出后无残留进程 |
| 便携数据目录 | ✅ 自动生成 `<exe 同级>/LiveReview-Data/{logs,recordings}`，日志写入 `logs/app-YYYY-MM-DD.log`（`portable:true`） |
| exe 内嵌图标 | ✅ 与原版一致的 7 档尺寸（16/24/32/48/64/128/256，32bpp） |

**排查记录（都记在案，避免下次重踩）**

- 打包第一次失败：`electron-builder` 下 `icons-bundle.tar.gz` 时 TLS 被掐（见「一、本机环境注意事项」第 5 条）。
  修法 = 代理 + 镜像，一次通过。
- 一度以为是死锁（19 分钟无输出），实际是 TLS 等待 + 后来误判 LZMA 压缩。
  定位靠 `--dir` 二分：`--dir` 能过 → 说明解包没问题 → 问题在后续下载。
- 便携版「启动 5 次全失败」查了很久，真因是**测试环境的 `ELECTRON_RUN_AS_NODE=1`**
  （工具宿主注入到会话环境，用户级/系统级注册表里都没有）。`Start-Process` 继承了这个变量 →
  内层 Electron 退化成纯 Node → 进程存活约 300 ms 后静默退出、**不写日志**。
  清掉变量后立刻 5/5。**这不是应用的问题**，真人双击不会遇到；
  但排查时要注意：**症状「进程秒退且无任何日志」优先怀疑环境变量污染**。
