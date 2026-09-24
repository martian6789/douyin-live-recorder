/**
 * 弹幕连接管理：一个房间一条连接，消息统一广播给调用方（落盘 + 实时展示）。
 *
 * 与录制解耦：即使不录制，只要主播开启了弹幕，界面上也能看到实时弹幕流。
 */
import { EventEmitter } from 'node:events'
import type { DanmakuMessage, PlatformId } from '../shared/types'
import { getProvider, type DanmakuPayload } from './providers'
import { getConfig, getCookie } from './store'
import { roomKey } from './danmaku'
import { log } from './logger'

const L = log('danmaku-hub')

export type DanmakuState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

export interface DanmakuStatus {
  streamerId: string
  platform: PlatformId
  roomId: string
  state: DanmakuState
  count: number
  since?: number
  error?: string
  lastMessage?: { user: string; text: string; type: string; offset: number }
}

interface Conn {
  streamerId: string
  platform: PlatformId
  roomId: string
  client: { close: () => void }
  state: DanmakuState
  count: number
  since: number
  error?: string
  lastMessage?: DanmakuStatus['lastMessage']
  retryTimer?: NodeJS.Timeout
  retries: number
}

/** 对外事件：message（带 streamerId）、status（状态变化） */
export class DanmakuHub extends EventEmitter {
  private conns = new Map<string, Conn>()
  private seq = 0

  constructor() {
    super()
    this.setMaxListeners(0)
  }

  /** 拉取某主播的弹幕（若已连接则复用） */
  subscribe(streamerId: string, platform: PlatformId, roomId: string): void {
    const key = streamerId
    if (this.conns.has(key)) return

    const provider = getProvider(platform)
    if (!provider.danmakuSupported) {
      this.conns.set(key, {
        streamerId,
        platform,
        roomId,
        client: { close: () => void 0 },
        state: 'error',
        count: 0,
        since: Date.now(),
        retries: 0,
        error: '该平台暂未实现弹幕'
      })
      this.emitStatus(key)
      return
    }

    const cfg = getConfig()
    const conn: Conn = {
      streamerId,
      platform,
      roomId,
      client: { close: () => void 0 },
      state: 'connecting',
      count: 0,
      since: Date.now(),
      retries: 0
    }
    this.conns.set(key, conn)
    this.emitStatus(key)

    const connect = (): void => {
      try {
        conn.state = 'connecting'
        this.emitStatus(key)
        conn.client = provider.createDanmaku(
          roomId,
          { ua: cfg.userAgent, cookie: getCookie(platform) },
          {
            onMessage: (m: DanmakuPayload) => this.handleMessage(key, m),
            onStatus: (s) => {
              conn.state = s === 'open' ? 'open' : s === 'connecting' ? 'connecting' : 'closed'
              this.emitStatus(key)
              if (s === 'closed') this.scheduleReconnect(key)
            },
            onError: (e) => {
              conn.state = 'error'
              conn.error = e.message
              this.emitStatus(key)
              this.scheduleReconnect(key)
            }
          }
        )
      } catch (e: any) {
        conn.state = 'error'
        conn.error = e?.message ?? String(e)
        this.emitStatus(key)
        this.scheduleReconnect(key)
      }
    }

    connect()
  }

  private scheduleReconnect(key: string): void {
    const conn = this.conns.get(key)
    if (!conn || conn.retryTimer) return
    if (conn.retries >= 10) return
    conn.retries += 1
    const delay = Math.min(30_000, 2000 * conn.retries)
    conn.retryTimer = setTimeout(() => {
      conn.retryTimer = undefined
      if (!this.conns.has(key)) return
      L.info('重连弹幕', key, `第 ${conn.retries} 次`)
      try {
        conn.client.close()
      } catch {
        /* ignore */
      }
      this.conns.delete(key)
      this.subscribe(conn.streamerId, conn.platform, conn.roomId)
    }, delay)
  }

  private handleMessage(key: string, payload: DanmakuPayload): void {
    const conn = this.conns.get(key)
    if (!conn) return
    const msg: DanmakuMessage = {
      ...payload,
      seq: ++this.seq,
      ts: Date.now(),
      offset: Date.now() - conn.since
    }
    conn.count += 1
    conn.lastMessage = { user: msg.user, text: msg.text, type: msg.type, offset: msg.offset }
    this.emit('message', key, msg)
  }

  private emitStatus(key: string): void {
    this.emit('status', this.statusOf(key))
  }

  statusOf(streamerId: string): DanmakuStatus {
    const c = this.conns.get(streamerId)
    if (!c) {
      return { streamerId, platform: 'bilibili', roomId: '', state: 'idle', count: 0 }
    }
    return {
      streamerId,
      platform: c.platform,
      roomId: c.roomId,
      state: c.state,
      count: c.count,
      since: c.since,
      error: c.error,
      lastMessage: c.lastMessage
    }
  }

  getStatuses(): DanmakuStatus[] {
    return [...this.conns.keys()].map((k) => this.statusOf(k))
  }

  unsubscribe(streamerId: string): void {
    const c = this.conns.get(streamerId)
    if (!c) return
    if (c.retryTimer) clearTimeout(c.retryTimer)
    try {
      c.client.close()
    } catch {
      /* ignore */
    }
    this.conns.delete(streamerId)
    this.emitStatus(streamerId)
  }

  /** 按主播配置批量订阅/退订 */
  sync(streamers: { id: string; platform: PlatformId; roomId: string; danmakuEnabled: boolean }[]): void {
    const want = new Map(streamers.filter((s) => s.danmakuEnabled).map((s) => [s.id, s]))
    for (const id of [...this.conns.keys()]) {
      if (!want.has(id)) this.unsubscribe(id)
    }
    for (const s of want.values()) {
      if (!this.conns.has(s.id)) this.subscribe(s.id, s.platform, s.roomId)
    }
  }

  stopAll(): void {
    for (const id of [...this.conns.keys()]) this.unsubscribe(id)
  }

  get activeCount(): number {
    return this.conns.size
  }

  get totalMessages(): number {
    return this.seq
  }

  keyOf(platform: PlatformId, roomId: string): string {
    return roomKey(platform, roomId)
  }
}

export const danmakuHub = new DanmakuHub()
