import fs from 'node:fs'
import path from 'node:path'

export function now() {
  return Date.now()
}

export function clip(value, limit = 200) {
  const text = value === undefined || value === null ? '' : String(value)
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`
}

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 深合并：对象逐层合并，数组与标量直接覆盖。 */
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base
  const out = isPlainObject(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value)
    else out[key] = value
  }
  return out
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

export function randInt(min, max) {
  const lo = Math.ceil(Math.min(min, max))
  const hi = Math.floor(Math.max(min, max))
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

export function pick(list) {
  if (!Array.isArray(list) || list.length === 0) return undefined
  return list[Math.floor(Math.random() * list.length)]
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    if (!text.trim()) return fallback
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** 原子写：先写 .tmp 再 rename，避免进程被杀时留下半个文件。 */
export function writeJson(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  return value
}

export function appendJsonl(file, value) {
  try {
    ensureDir(path.dirname(file))
    fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
  } catch {
    // 审计日志写失败不影响主流程
  }
}

/** 从模型输出里抠出第一个完整 JSON 对象，容忍 ```json 包裹和前后废话。 */
export function extractJson(text) {
  const raw = String(text || '')
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const source = fenced ? fenced[1] : raw
  const start = source.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export function formatClock(ts) {
  const date = new Date(ts || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function todayKey(ts = Date.now()) {
  const date = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 简易令牌桶：1 秒内最多 rate 次，超出返回 false。 */
export class TokenBucket {
  constructor(rate) {
    this.rate = Math.max(1, Number(rate) || 1)
    this.windowAt = 0
    this.count = 0
  }

  take(rate) {
    const limit = Math.max(1, Number(rate ?? this.rate) || 1)
    const t = Date.now()
    if (t - this.windowAt >= 1000) {
      this.windowAt = t
      this.count = 0
    }
    this.count += 1
    return this.count <= limit
  }
}

export function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
}
