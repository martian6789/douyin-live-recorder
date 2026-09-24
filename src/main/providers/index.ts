import type { PlatformId } from '../../shared/types'
import type { LiveProvider } from './types'
import { bilibiliProvider } from './bilibili'
import { douyuProvider } from './douyu'
import { huyaProvider } from './huya'
import { douyinProvider } from './douyin'
import { kuaishouProvider } from './kuaishou'

/** 平台注册表。新增平台 = 写好 adapter 后在这里加一行，UI 会自动出现选项。 */
export const providers: Record<PlatformId, LiveProvider> = {
  bilibili: bilibiliProvider,
  douyu: douyuProvider,
  huya: huyaProvider,
  douyin: douyinProvider,
  kuaishou: kuaishouProvider
}

export function getProvider(id: PlatformId): LiveProvider {
  const p = providers[id]
  if (!p) throw new Error(`未注册的平台：${id}`)
  return p
}

export function listPlatforms(): { id: PlatformId; name: string; danmaku: boolean }[] {
  return Object.values(providers).map((p) => ({
    id: p.id,
    name: p.name,
    danmaku: p.danmakuSupported
  }))
}

export * from './types'
