/**
 * 通知分发。原版的「消息通知」是三通道：企业微信机器人 / 自定义 Webhook / 邮件。
 * 这里保持同样的三通道，但把开关与模板都收到 config.notify 下，界面上可即时测试。
 *
 * 设计：notify(event, ctx) 永远不抛错（通知失败不该把录制拖挂），失败只写日志 + 发事件。
 */
import { EventEmitter } from 'node:events'
import type { NotifyConfig } from '../shared/types'
import { getConfig } from './store'
import { log } from './logger'

const L = log('notify')

export const notifier = new EventEmitter()
notifier.setMaxListeners(0)

export type NotifyEvent =
  | 'live-start'
  | 'record-start'
  | 'record-end'
  | 'error'
  | 'disk-warning'
  | 'test'

export interface NotifyContext {
  event: NotifyEvent
  name?: string
  platform?: string
  platformName?: string
  title?: string
  roomId?: string
  file?: string
  sizeText?: string
  durationText?: string
  message?: string
}

const EVENT_LABEL: Record<NotifyEvent, string> = {
  'live-start': '开播提醒',
  'record-start': '开始录制',
  'record-end': '录制完成',
  error: '异常告警',
  'disk-warning': '磁盘告警',
  test: '通知测试'
}

/** 该事件在配置里是否开启 */
function enabledFor(cfg: NotifyConfig, event: NotifyEvent): boolean {
  switch (event) {
    case 'live-start':
      return cfg.onLiveStart
    case 'record-start':
      return cfg.onRecordStart
    case 'record-end':
      return cfg.onRecordEnd
    case 'error':
      return cfg.onError
    case 'disk-warning':
      return cfg.onDiskWarning
    default:
      return true
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 模板变量：{event} {eventLabel} {name} {platform} {title} {roomId} {file} {size} {duration} {time} {date} */
export function renderBody(tpl: string, ctx: NotifyContext): string {
  const d = new Date()
  const vars: Record<string, string> = {
    event: ctx.event,
    eventLabel: EVENT_LABEL[ctx.event] ?? ctx.event,
    name: ctx.name ?? '',
    platform: ctx.platform ?? '',
    platformName: ctx.platformName ?? ctx.platform ?? '',
    title: ctx.title ?? '',
    roomId: ctx.roomId ?? '',
    file: ctx.file ?? '',
    size: ctx.sizeText ?? '',
    duration: ctx.durationText ?? '',
    message: ctx.message ?? '',
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m))
}

function plainText(ctx: NotifyContext): string {
  const lines = [`【${EVENT_LABEL[ctx.event] ?? ctx.event}】`]
  if (ctx.name) lines.push(`主播：${ctx.name}`)
  if (ctx.platformName) lines.push(`平台：${ctx.platformName}`)
  if (ctx.title) lines.push(`标题：${ctx.title}`)
  if (ctx.file) lines.push(`文件：${ctx.file}`)
  if (ctx.sizeText) lines.push(`大小：${ctx.sizeText}`)
  if (ctx.durationText) lines.push(`时长：${ctx.durationText}`)
  if (ctx.message) lines.push(`说明：${ctx.message}`)
  lines.push(`时间：${renderBody('{date} {time}', ctx)}`)
  return lines.join('\n')
}

/* ============================ Webhook ============================ */

async function sendWebhook(cfg: NotifyConfig, ctx: NotifyContext): Promise<void> {
  const w = cfg.webhook
  if (!w.enabled || !w.url) return
  const body = renderBody(w.bodyTemplate || '{"msg":"{eventLabel}"}', ctx)
  const headers: Record<string, string> = { ...(w.headers || {}) }
  if (w.method !== 'GET' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json'
  }
  const url = w.method === 'GET' && body ? `${w.url}${w.url.includes('?') ? '&' : '?'}${body}` : w.url
  const res = await fetch(url, {
    method: w.method,
    headers,
    body: w.method === 'GET' ? undefined : body,
    signal: AbortSignal.timeout(10_000)
  })
  if (!res.ok) throw new Error(`Webhook 返回 ${res.status}`)
  L.info('webhook 已发送', ctx.event)
}

/* ============================ 企业微信机器人 ============================ */

async function sendWecom(cfg: NotifyConfig, ctx: NotifyContext): Promise<void> {
  const h = cfg.wecom
  if (!h.enabled || !h.webhook) return
  const res = await fetch(h.webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: plainText(ctx) } }),
    signal: AbortSignal.timeout(10_000)
  })
  const data: any = await res.json().catch(() => ({}))
  if (data?.errcode) throw new Error(`企业微信返回 ${data.errcode} ${data.errmsg ?? ''}`)
  L.info('企业微信已发送', ctx.event)
}

/* ============================ 邮件 ============================ */

/** nodemailer 是可选依赖：没装也只是邮件通道不可用，不影响其余功能 */
async function loadNodemailer(): Promise<any | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('nodemailer')
    return mod?.default ?? mod
  } catch {
    return null
  }
}

async function sendEmail(cfg: NotifyConfig, ctx: NotifyContext): Promise<void> {
  const e = cfg.email
  if (!e.enabled || !e.host || !e.to?.length) return
  const nodemailer = await loadNodemailer()
  if (!nodemailer) throw new Error('邮件通道需要 nodemailer，请先 npm install nodemailer')

  const transport = nodemailer.createTransport({
    host: e.host,
    port: e.port,
    secure: e.secure,
    auth: e.user ? { user: e.user, pass: e.pass } : undefined,
    connectionTimeout: 12_000,
    socketTimeout: 20_000
  })

  await transport.sendMail({
    from: e.from || e.user,
    to: e.to.join(','),
    subject: `[直播复盘] ${EVENT_LABEL[ctx.event] ?? ctx.event}${ctx.name ? ` - ${ctx.name}` : ''}`,
    text: plainText(ctx)
  })
  L.info('邮件已发送', ctx.event)
}

/* ============================ 对外入口 ============================ */

export interface NotifyResult {
  channel: 'webhook' | 'wecom' | 'email'
  ok: boolean
  error?: string
}

/**
 * 发送通知。event='test' 时无视开关，强制走一遍已启用的通道（供界面自测）。
 */
export async function notify(
  event: NotifyEvent,
  ctx: Partial<NotifyContext> = {}
): Promise<NotifyResult[]> {
  let cfg: NotifyConfig
  try {
    cfg = getConfig().notify
  } catch (e: any) {
    L.warn('读取通知配置失败', e?.message ?? e)
    return []
  }

  const full: NotifyContext = { event, ...ctx }
  const tasks: { channel: NotifyResult['channel']; run: () => Promise<void> }[] = []

  if (event === 'test' || enabledFor(cfg, event)) {
    if (cfg.webhook.enabled && cfg.webhook.url) tasks.push({ channel: 'webhook', run: () => sendWebhook(cfg, full) })
    if (cfg.wecom.enabled && cfg.wecom.webhook) tasks.push({ channel: 'wecom', run: () => sendWecom(cfg, full) })
    if (cfg.email.enabled && cfg.email.host) tasks.push({ channel: 'email', run: () => sendEmail(cfg, full) })
  }

  const results: NotifyResult[] = []
  for (const t of tasks) {
    try {
      await t.run()
      results.push({ channel: t.channel, ok: true })
    } catch (e: any) {
      const error = e?.message ?? String(e)
      L.warn(`通知失败（${t.channel}）`, error)
      results.push({ channel: t.channel, ok: false, error })
    }
  }

  notifier.emit('sent', { event, results, context: full })
  return results
}
