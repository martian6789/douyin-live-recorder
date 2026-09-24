import type { DanmakuMessage, PlatformId, RoomInfo, StreamVariant } from '../../shared/types'

/** Provider 运行期上下文：由主进程注入，避免 provider 直接依赖 store。 */
export interface ProviderContext {
  ua: string
  cookie: string
}

export type DanmakuPayload = Omit<DanmakuMessage, 'seq' | 'ts' | 'offset'>

export interface DanmakuHandlers {
  onMessage: (m: DanmakuPayload) => void
  onStatus?: (s: 'connecting' | 'open' | 'closed') => void
  onError?: (e: Error) => void
}

export interface DanmakuClient {
  /** 关闭连接（幂等） */
  close: () => void
}

/**
 * 平台适配器接口。
 * 新增平台 = 实现这个接口 + 在 index.ts 注册，主进程与 UI 无需改动。
 */
export interface LiveProvider {
  id: PlatformId
  name: string
  /** 该平台是否已完成弹幕接入 */
  danmakuSupported: boolean
  /** 从用户输入（URL 或房间号）解析出真实房间号 */
  parseRoomId: (input: string) => string | null
  getRoomInfo: (roomId: string, ctx: ProviderContext) => Promise<RoomInfo>
  /** 返回可用清晰度列表，从高到低 */
  getStreams: (roomId: string, ctx: ProviderContext) => Promise<StreamVariant[]>
  /** 建立弹幕连接；不支持时抛错 */
  createDanmaku: (roomId: string, ctx: ProviderContext, h: DanmakuHandlers) => DanmakuClient
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} 尚未实现`)
    this.name = 'NotImplementedError'
  }
}

/** 十进制颜色转为 #rrggbb */
export function intToHexColor(n: number): string {
  if (!n || n < 0) return '#ffffff'
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0')
}
