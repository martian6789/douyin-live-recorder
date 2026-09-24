/** 界面通用格式化。全部纯函数，方便在模板里直接调用。 */

export function formatBytes(n: number | undefined): string {
  if (!n || n < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return '00:00'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const p = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${p(h)}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`
}

export function formatTime(ts: number | undefined, withDate = true): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return withDate ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}` : time
}

export function formatDate(ts: number | undefined): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 昨天 12:30 */
export function fromNow(ts: number | undefined): string {
  if (!ts) return '-'
  const diff = Date.now() - ts
  if (diff < 0) return '刚刚'
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day === 1) return `昨天 ${formatTime(ts, false)}`
  if (day < 30) return `${day} 天前`
  return formatDate(ts)
}

export function platformLabel(meta: { name: string }[] | undefined, id: string): string {
  return meta?.find((m) => (m as { id?: string }).id === id)?.name ?? id
}

export function extColor(ext: string): string {
  switch (ext?.toLowerCase()) {
    case 'mp4':
      return 'var(--song)'
    case 'ts':
      return 'var(--lan)'
    case 'flv':
      return 'var(--jin)'
    case 'mkv':
      return 'var(--zhu)'
    default:
      return 'var(--ink-3)'
  }
}
