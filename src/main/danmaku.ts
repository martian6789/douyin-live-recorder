/**
 * 弹幕落盘：JSONL（全量原始事件）+ ASS（可挂字幕回放）。
 *
 * 写入策略：ASS 逐行追加但走缓冲，避免每条弹幕一次 syscall；
 * JSONL 用流式写入。两者的 offset 都相对录制起点，方便和视频对齐。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DanmakuMessage, PlatformId } from '../shared/types'

const MAX_ASS_EVENTS = 20000
const FLUSH_EVERY = 25

export function roomKey(platform: PlatformId, roomId: string): string {
  return `${platform}:${roomId}`
}

function assTime(ms: number): string {
  const clamped = Math.max(0, ms)
  const h = Math.floor(clamped / 3600000)
  const m = Math.floor((clamped % 3600000) / 60000)
  const s = Math.floor((clamped % 60000) / 1000)
  const cs = Math.floor((clamped % 1000) / 10)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(
    2,
    '0'
  )}`
}

function escapeAss(s: string): string {
  return s.replace(/\{/g, '（').replace(/\}/g, '）').replace(/\r?\n/g, ' ')
}

const ASS_HEADER = `[Script Info]
Title: LiveReview Danmaku
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Chat,Microsoft YaHei,30,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,1,0,2,20,20,20,1
Style: Gift,Microsoft YaHei,28,&H0000FFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,1,0,2,20,20,60,1
Style: SC,Microsoft YaHei,28,&H008080FF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,2,0,2,40,40,120,1
Style: System,Microsoft YaHei,26,&H00C0C0C0,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,1,0,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`

function styleOf(m: DanmakuMessage): string {
  if (m.type === 'superchat') return 'SC'
  if (m.type === 'gift') return 'Gift'
  if (m.type === 'system') return 'System'
  return 'Chat'
}

export interface WriterOptions {
  saveJsonl: boolean
  exportAss: boolean
  /** 只保留这些类型；留空表示全留 */
  keepTypes?: DanmakuMessage['type'][]
}

/** 一次录制的弹幕写入器 */
export class DanmakuWriter {
  private seq = 0
  private jsonl: fs.WriteStream | null = null
  private jsonlFd: number | null = null
  private jsonlPath = ''
  private assPath = ''
  private startedAt = 0
  private buffer: string[] = []

  constructor(
    private dir: string,
    private basename: string,
    private opts: WriterOptions
  ) {}

  begin(startedAt: number): void {
    this.startedAt = startedAt
    fs.mkdirSync(this.dir, { recursive: true })

    if (this.opts.saveJsonl) {
      this.jsonlPath = path.join(this.dir, `${this.basename}.danmaku.jsonl`)
      this.jsonl = fs.createWriteStream(this.jsonlPath, { flags: 'a', encoding: 'utf8' })
      this.jsonlFd = null
    }

    if (this.opts.exportAss) {
      this.assPath = path.join(this.dir, `${this.basename}.danmaku.ass`)
      if (!fs.existsSync(this.assPath)) {
        fs.writeFileSync(this.assPath, ASS_HEADER, 'utf8')
        this.jsonlFd = fs.openSync(this.assPath, 'a')
      } else {
        this.jsonlFd = fs.openSync(this.assPath, 'a')
      }
    }
  }

  private accept(m: DanmakuMessage): boolean {
    if (!this.opts.keepTypes?.length) return true
    return this.opts.keepTypes.includes(m.type)
  }

  /** 写入一条弹幕，返回补全 seq/ts/offset 的完整对象 */
  push(payload: Omit<DanmakuMessage, 'seq' | 'ts' | 'offset'>): DanmakuMessage {
    const ts = Date.now()
    const msg: DanmakuMessage = {
      ...payload,
      seq: ++this.seq,
      ts,
      offset: Math.max(0, ts - this.startedAt)
    }

    if (!this.accept(msg)) return msg

    if (this.jsonl) this.jsonl.write(JSON.stringify(msg) + '\n')

    if (this.opts.exportAss && this.seq <= MAX_ASS_EVENTS) {
      const start = assTime(msg.offset)
      const end = assTime(msg.offset + 5000)
      let text = `${msg.user}：${msg.text}`
      if (msg.type === 'gift' && msg.giftName) {
        text = `${msg.user} 送出 ${msg.giftName}${msg.giftCount && msg.giftCount > 1 ? ` ×${msg.giftCount}` : ''}`
      }
      this.buffer.push(
        `Dialogue: 0,${start},${end},${styleOf(msg)},,0,0,0,,${escapeAss(text)}\n`
      )
      if (this.buffer.length >= FLUSH_EVERY) this.flush()
    }
    return msg
  }

  private flush(): void {
    if (!this.buffer.length || this.jsonlFd == null) {
      this.buffer = []
      return
    }
    try {
      fs.writeSync(this.jsonlFd, this.buffer.join(''))
    } catch {
      /* ignore */
    }
    this.buffer = []
  }

  get count(): number {
    return this.seq
  }

  get files(): { jsonl?: string; ass?: string } {
    return {
      jsonl: this.jsonlPath || undefined,
      ass: this.assPath || undefined
    }
  }

  close(): { jsonl?: string; ass?: string; count: number } {
    this.flush()
    try {
      this.jsonl?.end()
    } catch {
      /* ignore */
    }
    this.jsonl = null
    if (this.jsonlFd != null) {
      try {
        fs.closeSync(this.jsonlFd)
      } catch {
        /* ignore */
      }
      this.jsonlFd = null
    }
    return { jsonl: this.jsonlPath || undefined, ass: this.assPath || undefined, count: this.seq }
  }
}

/* ============================ 伴随文件 ============================ */

export interface Companions {
  danmakuFile?: string
  assFile?: string
  srtFile?: string
  txtFile?: string
  audioFile?: string
  subFiles: string[]
}

/** 给定一个视频文件，找出同名的弹幕/字幕/转写产物 */
export function companions(videoPath: string): Companions {
  const dir = path.dirname(videoPath)
  const base = path.basename(videoPath).replace(/\.[^.]+$/, '')
  const out: Companions = { subFiles: [] }
  const probe = (suffix: string, key: keyof Companions): void => {
    const p = path.join(dir, base + suffix)
    if (fs.existsSync(p)) {
      ;(out as any)[key] = p
      out.subFiles.push(p)
    }
  }
  probe('.danmaku.jsonl', 'danmakuFile')
  probe('.danmaku.ass', 'assFile')
  probe('.srt', 'srtFile')
  probe('.vtt', 'srtFile')
  probe('.txt', 'txtFile')
  probe('.m4a', 'audioFile')
  probe('.wav', 'audioFile')
  return out
}

/** 分段文件判断：xxx_001.mp4 / xxx_001.ts */
export function isSegment(file: string): boolean {
  return /_\d{3,4}\.[a-z0-9]+$/i.test(path.basename(file))
}

/** 从分段文件推出「同一组」的基名，用于合并 */
export function segmentBase(file: string): string {
  return file.replace(/_\d{3,4}(\.[a-z0-9]+)$/i, '$1')
}
