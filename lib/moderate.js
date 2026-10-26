import { normalizeText } from './util.js'

const AD_PATTERNS = [
  /https?:\/\//i,
  /(^|[^a-z])www\./i,
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  /(加群|进群|qq群|vx|v信|威信|微信|加我|私聊|私我|代练|接单|外挂|脚本|免费领|福利群|资源群|卖号|出号|刷粉|涨粉)/i,
  /(?:qq|群号|裙号)[^\d]{0,4}\d{5,11}/i,
]

const INSULT_WORDS = [
  '傻逼', '煞笔', '沙比', '傻b', '傻比', '脑残', '智障', '废物', '狗东西', '畜生', '贱人', '滚蛋',
  'nmsl', 'nm$l', 'cnm', '你妈死', '死全家', '全家死', '去死', '恶心死了', '垃圾玩意', '妈的',
]

const HARASS_PATTERNS = [/滚出直播间/, /别看了/, /滚出去/, /拉黑你/, /举报你/, /弄死你/, /打死你/]

const SPOILER_PATTERNS = [/剧透/, /结局是/, /大结局/, /凶手是/, /最后.{0,4}死/, /结局.{0,3}是/]

const FRIENDLY_PATTERN = /^[哈呵嘿嘻草笑哭2333呃嗯6doge\s。、,.!?？！~～]+$/i
const LAUGH_PATTERN = /^(哈{2,}|草{2,}|笑死|2333+|hahaha+)$/i

function countRepeats(text) {
  const chars = [...text]
  if (chars.length < 2) return 0
  let best = 1
  let run = 1
  for (let i = 1; i < chars.length; i += 1) {
    if (chars[i] === chars[i - 1]) run += 1
    else run = 1
    if (run > best) best = run
  }
  return best
}

function repeatedChunk(text, unit = 2) {
  if (text.length < unit * 3) return 0
  let best = 0
  for (let size = 1; size <= Math.min(4, text.length); size += 1) {
    const chunk = text.slice(0, size)
    let count = 0
    for (let i = 0; i + size <= text.length; i += size) {
      if (text.slice(i, i + size) !== chunk) break
      count += 1
    }
    if (count * size >= text.length * 0.8 && count >= 3) best = Math.max(best, count)
  }
  return best
}

/** 记录每个人发言，用来找「同一句话刷屏」。 */
export class TextHistory {
  constructor(limit = 40) {
    this.limit = limit
    this.map = new Map()
  }

  add(uid, text, ts = Date.now()) {
    const key = String(uid)
    const list = this.map.get(key) || []
    list.push({ text: normalizeText(text).slice(0, 60), ts })
    while (list.length > this.limit) list.shift()
    this.map.set(key, list)
    if (this.map.size > 2000) {
      const cutoff = ts - 10 * 60_000
      for (const [k, v] of this.map) {
        if (!v.length || v[v.length - 1].ts < cutoff) this.map.delete(k)
      }
    }
  }

  countWithin(uid, windowMs, matcher) {
    const now = Date.now()
    const list = this.map.get(String(uid)) || []
    return list.filter((item) => now - item.ts <= windowMs && matcher(item.text)).length
  }

  sameCount(uid, text, windowMs) {
    const target = normalizeText(text)
    if (!target) return 0
    return this.countWithin(uid, windowMs, (item) => item === target)
  }
}

/**
 * 规则初筛：只在「明显该管」时给候选，剩下的交给模型判断。
 * 返回 { category, reason, score } 或 null。
 */
export function judge(event, { config, history }) {
  const text = normalizeText(event.text)
  if (!text) return null
  const moderation = config.moderation || {}
  const muteOn = moderation.muteOn || {}
  const extra = Array.isArray(moderation.extraWords) ? moderation.extraWords.filter(Boolean) : []

  if (text.length >= 3 && LAUGH_PATTERN.test(text)) return null
  if (FRIENDLY_PATTERN.test(text) && !moderation.extraWords?.length) return null

  const uid = event.uid

  // 1) 广告拉人
  if (muteOn.ad !== false && AD_PATTERNS.some((re) => re.test(text))) {
    return { category: 'ad', reason: `疑似广告/拉人：${text.slice(0, 40)}`, score: 90 }
  }

  // 2) 自定义词
  if (extra.some((word) => word && text.includes(word))) {
    return { category: 'ad', reason: `命中自定义过滤词：${text.slice(0, 40)}`, score: 88 }
  }

  // 3) 刷屏
  if (muteOn.spam !== false) {
    const same = history ? history.sameCount(uid, text, 120_000) : 0
    const run = countRepeats(text)
    const chunk = repeatedChunk(text)
    const emojiRepeat = /(\[[^\]]{1,8}\]){5,}/.test(text)
    if (same >= 2 || run >= 8 || chunk >= 4 || emojiRepeat || (text.length >= 30 && run >= 5)) {
      return { category: 'spam', reason: `刷屏（${text.length} 字，重复 ${Math.max(same + 1, run, chunk)} 次）`, score: 80 }
    }
  }

  // 4) 辱骂
  if (muteOn.insult !== false) {
    const hit = INSULT_WORDS.find((word) => text.toLowerCase().includes(word))
    if (hit) return { category: 'insult', reason: `疑似辱骂：${hit}`, score: 85 }
  }

  // 5) 骚扰/威胁
  if (muteOn.harassment !== false) {
    const hit = HARASS_PATTERNS.find((re) => re.test(text))
    if (hit) return { category: 'harassment', reason: `疑似骚扰/威胁：${hit.source}`, score: 85 }
    const ats = (text.match(/@[^\s@]{1,20}/g) || []).length
    if (ats >= 3) return { category: 'harassment', reason: '连续 @ 多人', score: 70 }
  }

  // 6) 剧透
  if (muteOn.spoiler === true) {
    const hit = SPOILER_PATTERNS.find((re) => re.test(text))
    if (hit) return { category: 'spoiler', reason: '疑似剧透', score: 75 }
  }

  return null
}

export function isWhitelisted(event, config) {
  const list = config.moderation?.whitelist || []
  if (!Array.isArray(list) || list.length === 0) return false
  return list.some((item) => {
    if (item === undefined || item === null) return false
    const value = String(item).trim()
    if (!value) return false
    return value === String(event.uid) || (event.name && value === String(event.name))
  })
}

export function categoryLabel(category) {
  return (
    { ad: '发广告/拉人', spam: '刷屏', insult: '辱骂', harassment: '骚扰/引战', spoiler: '剧透' }[category] || '违规'
  )
}
