/**
 * 录像命名模板。原版叫「命名模板 + 变量预览 + 校验」，这里保持同样三件事。
 *
 * 模板示例：{platform}/{name}/{date}/{time}_{title}
 * 未识别的 {xxx} 会被原样保留并在校验里报出来，避免用户写了错变量却不知道。
 */
import path from 'node:path'
import type { PlatformId, TemplateVariable } from '../shared/types'
import { PLATFORMS } from '../shared/types'

export interface TemplateContext {
  platform: PlatformId | string
  platformName?: string
  name: string
  roomId: string
  title?: string
  quality?: string
  startedAt?: number
  seq?: number
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

export function templateVariables(): TemplateVariable[] {
  return [
    { key: 'platform', desc: '平台英文标识', sample: 'bilibili' },
    { key: 'platformName', desc: '平台中文名', sample: '哔哩哔哩' },
    { key: 'name', desc: '主播名（自动清洗非法字符）', sample: '某某主播' },
    { key: 'roomId', desc: '房间号', sample: '5440' },
    { key: 'title', desc: '直播间标题', sample: '今晚八点开播' },
    { key: 'quality', desc: '清晰度', sample: '原画' },
    { key: 'date', desc: '日期 YYYY-MM-DD', sample: '2026-09-20' },
    { key: 'time', desc: '时间 HHmmss', sample: '203015' },
    { key: 'datetime', desc: '日期时间 YYYYMMDD-HHmmss', sample: '20260920-203015' },
    { key: 'year', desc: '年', sample: '2026' },
    { key: 'month', desc: '月', sample: '09' },
    { key: 'day', desc: '日', sample: '20' },
    { key: 'hour', desc: '时', sample: '20' },
    { key: 'minute', desc: '分', sample: '30' },
    { key: 'second', desc: '秒', sample: '15' },
    { key: 'seq', desc: '分段序号（3 位）', sample: '001' }
  ]
}

/** Windows / macOS / Linux 通用：把非法字符换成下划线 */
export function sanitize(input: string): string {
  return (
    input
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[\s]+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 120) || 'unknown'
  )
}

export function buildVars(ctx: TemplateContext): Record<string, string> {
  const d = new Date(ctx.startedAt ?? Date.now())
  const platformName =
    ctx.platformName ?? PLATFORMS.find((p) => p.id === ctx.platform)?.name ?? String(ctx.platform)
  return {
    platform: String(ctx.platform),
    platformName,
    name: sanitize(ctx.name || 'unknown'),
    roomId: String(ctx.roomId ?? ''),
    title: sanitize(ctx.title || '未命名'),
    quality: ctx.quality || '',
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    datetime: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
      d.getHours()
    )}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    year: String(d.getFullYear()),
    month: pad(d.getMonth() + 1),
    day: pad(d.getDate()),
    hour: pad(d.getHours()),
    minute: pad(d.getMinutes()),
    second: pad(d.getSeconds()),
    seq: pad(ctx.seq ?? 0, 3)
  }
}

export function renderTemplate(tpl: string, ctx: TemplateContext): string {
  const vars = buildVars(ctx)
  const t = (tpl || '{platform}/{name}/{date}/{time}_{title}').trim()
  return t.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m))
}

export interface TemplateValidation {
  ok: boolean
  unknown: string[]
  /** 归一化后的相对路径（已做非法字符清洗） */
  normalized: string
  error?: string
}

export function validateTemplate(tpl: string, ctx?: TemplateContext): TemplateValidation {
  const t = (tpl || '').trim()
  if (!t) return { ok: false, unknown: [], normalized: '', error: '模板不能为空' }

  const known = new Set(templateVariables().map((v) => v.key))
  const unknown = [...new Set([...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].filter(
    (k) => !known.has(k)
  )

  const rendered = renderTemplate(t, ctx ?? { platform: 'bilibili', name: '示例主播', roomId: '5440', title: '示例标题' })
  const parts = rendered
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((p) => sanitize(p))

  if (!parts.length) return { ok: false, unknown, normalized: '', error: '模板渲染后为空' }

  const normalized = parts.join(path.sep)
  return { ok: unknown.length === 0, unknown, normalized }
}

/** 默认命名：主播名_直播开始时间（如 老飘讲故事_20260921-140503.mp4） */
export const DEFAULT_TEMPLATE = '{name}_{datetime}'
/** 旧版默认模板，读取旧配置时自动迁移到 DEFAULT_TEMPLATE */
export const LEGACY_DEFAULT_TEMPLATE = '{platform}/{name}/{date}/{time}_{title}'
