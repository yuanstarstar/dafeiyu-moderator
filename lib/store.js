import fs from 'node:fs'
import path from 'node:path'
import { appendJsonl, clip, deepMerge, ensureDir, now, readJson, todayKey, writeJson } from './util.js'

export const DEFAULT_CONFIG = {
  roomId: 0,
  enabled: false,
  dryRun: true,
  cookieFile: '', // 空 = 存到插件自己的 data/bili_credential.json（打包不带凭证）
  pythonPath: '',
  ffmpegPath: '', // 空 = 自动找 PATH / 常见目录 / 插件自带
  persona: {
    name: '大肥鱼',
    species: '一条网上常见的蓝色大肥鱼',
    look: '圆滚滚的蓝色身子，肚皮偏浅，两片小短鳍当手，腮帮子鼓鼓的，一激动鳞片发亮',
    origin: '网上那条有名的蓝色大肥鱼，被主播捞进直播间当房管',
    selfCall: '本鱼',
    masterName: '主人',
    callAnchor: true,
    anchorName: '',
    tone: '嘴甜但不惯着，护主人，心软手不软',
    catchphrases: ['主人', '鱼在呢', '别刷了别刷了', '摸摸鳞片'],
    extra: '',
  },
  speak: {
    enabled: true,
    maxPerMinute: 4,
    minGapSec: 15,
    maxChars: 30,
    replyToAnchor: true,
    reactToGift: true,
    greetEnter: false,
    chatIntervalSec: 75,
    // 直播间静了这么久、又没有新弹幕时就不硬找话说（0 = 关掉这个限制）
    quietAfterSec: 180,
  },
  moderation: {
    enabled: true,
    warnBeforeMute: 2,
    windowMin: 30,
    muteMinutes: 5,
    autoUnban: true,
    maxMutesPerHour: 5,
    whitelist: [],
    extraWords: [],
    muteOn: { spam: true, ad: true, insult: true, harassment: true, spoiler: false },
  },
  // 思考等级：off（不思考，最快）/ low / medium / high；模型思考太久会把正文预算吃光
  llm: { effort: 'low' },
  vision: { enabled: true, intervalMin: 8, maxPerHour: 6 },
  asr: {
    enabled: true,
    // 空 = 自动找：<插件>/data/models > <插件>/models > ~/.dsh/speech-to-text/sensevoice/models
    modelDir: '',
    language: 'zh',
    minSpeechSec: 0.6,
    gapSec: 1.2,
    maxPerMinute: 30,
    reactToName: true,
    maxChars: 40,
  },
  quietHours: { enabled: false, start: '03:00', end: '07:00' },
}

export const MAX_EVENTS = 300
export const MAX_ACTIONS = 200

function emptyCounters() {
  return { danmaku: 0, gifts: 0, sc: 0, enters: 0, follows: 0, says: 0, warns: 0, mutes: 0, unbans: 0, llmCalls: 0, visionCalls: 0 }
}

export class Store {
  constructor(rootDir) {
    this.rootDir = rootDir
    this.dataDir = ensureDir(path.join(rootDir, 'data'))
    this.snapshotDir = ensureDir(path.join(this.dataDir, 'snapshots'))
    this.configFile = path.join(this.dataDir, 'config.json')
    this.stateFile = path.join(this.dataDir, 'state.json')
    this.actionLog = path.join(this.dataDir, 'actions.jsonl')
    this.events = []
    this.actions = []
    this.saveTimer = null
    this.config = deepMerge(DEFAULT_CONFIG, readJson(this.configFile, {}))
    this.state = this.#loadState()
    this.#resetDayIfNeeded()
  }

  /** B 站凭证存哪：配置里写了就用配置的，否则落在插件自己的 data 目录（打包时天然不带）。 */
  credentialPath() {
    const raw = String(this.getConfig().cookieFile || '').trim()
    return raw || path.join(this.dataDir, 'bili_credential.json')
  }

  #loadState() {
    const saved = readJson(this.stateFile, {}) || {}
    return {
      day: saved.day || todayKey(),
      counters: { ...emptyCounters(), ...(saved.counters || {}) },
      ledger: saved.ledger && typeof saved.ledger === 'object' ? saved.ledger : {},
      pendingUnbans: Array.isArray(saved.pendingUnbans) ? saved.pendingUnbans : [],
      speakPausedUntil: Number(saved.speakPausedUntil) || 0,
      lastScene: saved.lastScene || null,
      totals: { ...emptyCounters(), ...(saved.totals || {}) },
    }
  }

  #resetDayIfNeeded() {
    const today = todayKey()
    if (this.state.day === today) return false
    for (const [key, value] of Object.entries(this.state.counters)) {
      this.state.totals[key] = (this.state.totals[key] || 0) + (value || 0)
    }
    this.state.day = today
    this.state.counters = emptyCounters()
    this.saveState()
    return true
  }

  getConfig() {
    return this.config
  }

  patchConfig(patch) {
    this.config = deepMerge(this.config, patch || {})
    // 房间号/开关这类裸字段做一次类型收敛，避免前端传字符串
    this.config.roomId = Number(this.config.roomId) || 0
    this.config.enabled = !!this.config.enabled
    this.config.dryRun = !!this.config.dryRun
    writeJson(this.configFile, this.config)
    return this.config
  }

  saveState() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 400)
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref()
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      writeJson(this.stateFile, this.state)
    } catch {
      // 落盘失败不阻塞
    }
  }

  bump(key, n = 1) {
    this.#resetDayIfNeeded()
    this.state.counters[key] = (this.state.counters[key] || 0) + n
    this.saveState()
    return this.state.counters[key]
  }

  counters() {
    this.#resetDayIfNeeded()
    return this.state.counters
  }

  totals() {
    return this.state.totals
  }

  pushEvent(event) {
    const item = { ...event, ts: event.ts || now() }
    // 同一条弹幕可能从 ws 和历史接口各来一次，短时间内同样的内容只留一条
    if (item.type === 'danmaku' && item.text) {
      const text = String(item.text)
      const uid = Number(item.uid) || 0
      const dup = this.events.slice(-12).some((prev) => {
        if (prev.type !== 'danmaku') return false
        if (String(prev.text || '') !== text) return false
        if ((Number(prev.uid) || 0) !== uid) return false
        return Math.abs(Number(item.ts) - Number(prev.ts)) < 5_000
      })
      if (dup) return null
    }
    this.events.push(item)
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
    return item
  }

  recentEvents(limit = 40) {
    return this.events.slice(-Math.max(1, Math.min(MAX_EVENTS, Number(limit) || 40)))
  }

  pushAction(action) {
    const item = { ts: now(), ok: true, ...action }
    this.actions.push(item)
    if (this.actions.length > MAX_ACTIONS) this.actions.splice(0, this.actions.length - MAX_ACTIONS)
    appendJsonl(this.actionLog, item)
    return item
  }

  recentActions(limit = 60) {
    return this.actions.slice(-Math.max(1, Math.min(MAX_ACTIONS, Number(limit) || 60)))
  }

  ledgerGet(uid) {
    const key = String(uid)
    if (!this.state.ledger[key]) {
      this.state.ledger[key] = {
        uid: Number(uid) || 0,
        name: '',
        warns: 0,
        mutes: 0,
        lastAt: 0,
        lastReason: '',
        lastCategory: '',
        mutedUntil: null,
        mutedAt: null,
        notes: [],
      }
    }
    return this.state.ledger[key]
  }

  ledgerTouch(uid, name) {
    if (!uid) return null
    const entry = this.ledgerGet(uid)
    if (name && name !== entry.name) entry.name = name
    return entry
  }

  /** 窗口内已提醒次数（用于「多次提醒不改才禁言」）。 */
  warnsWithin(uid, windowMin) {
    const entry = this.ledgerGet(uid)
    const cutoff = now() - Math.max(1, Number(windowMin) || 30) * 60_000
    const hits = (entry.notes || []).filter((n) => n.kind === 'warn' && n.at >= cutoff)
    return hits.length
  }

  recordWarn(uid, name, reason, category) {
    const entry = this.ledgerTouch(uid, name)
    if (!entry) return null
    entry.warns += 1
    entry.lastAt = now()
    entry.lastReason = clip(reason, 80)
    entry.lastCategory = category || ''
    entry.notes = [...(entry.notes || []).slice(-30), { kind: 'warn', at: now(), reason: clip(reason, 80), category: category || '' }]
    this.saveState()
    return entry
  }

  recordMute(uid, name, reason, category, minutes, until) {
    const entry = this.ledgerTouch(uid, name)
    if (!entry) return null
    entry.mutes += 1
    entry.lastAt = now()
    entry.lastReason = clip(reason, 80)
    entry.lastCategory = category || ''
    entry.mutedAt = now()
    entry.mutedUntil = until || now() + Math.max(1, Number(minutes) || 5) * 60_000
    entry.notes = [...(entry.notes || []).slice(-30), { kind: 'mute', at: now(), reason: clip(reason, 80), category: category || '', minutes: Number(minutes) || 5 }]
    this.state.pendingUnbans = (this.state.pendingUnbans || []).filter((x) => String(x.uid) !== String(uid))
    this.state.pendingUnbans.push({ uid: Number(uid), name: name || entry.name || '', at: entry.mutedUntil })
    this.saveState()
    return entry
  }

  recordUnban(uid) {
    const entry = this.ledgerGet(uid)
    entry.mutedUntil = null
    entry.notes = [...(entry.notes || []).slice(-30), { kind: 'unban', at: now() }]
    this.state.pendingUnbans = (this.state.pendingUnbans || []).filter((x) => String(x.uid) !== String(uid))
    this.saveState()
    return entry
  }

  ledgerList(limit = 50) {
    const rows = Object.values(this.state.ledger)
      .filter((row) => row && (row.warns > 0 || row.mutes > 0))
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
      .slice(0, Math.max(1, Number(limit) || 50))
      .map((row) => ({
        uid: row.uid,
        name: row.name || `用户${row.uid}`,
        warns: row.warns,
        mutes: row.mutes,
        lastAt: row.lastAt,
        lastReason: row.lastReason,
        lastCategory: row.lastCategory,
        mutedUntil: row.mutedUntil && row.mutedUntil > now() ? row.mutedUntil : null,
      }))
    return rows
  }

  setSpeakPausedUntil(ts) {
    this.state.speakPausedUntil = Number(ts) || 0
    this.saveState()
    return this.state.speakPausedUntil
  }

  speakPausedUntil() {
    return Number(this.state.speakPausedUntil) || 0
  }

  setLastScene(scene) {
    this.state.lastScene = scene
    this.saveState()
  }

  lastScene() {
    return this.state.lastScene
  }

  /** 清理过期提醒记录，防止 ledger 无限膨胀。 */
  pruneLedger(days = 14) {
    const cutoff = now() - days * 86_400_000
    let changed = false
    for (const [key, row] of Object.entries(this.state.ledger)) {
      if ((row.lastAt || 0) < cutoff && !row.mutedUntil) {
        delete this.state.ledger[key]
        changed = true
      }
    }
    if (changed) this.saveState()
  }

  pendingUnbans() {
    return Array.isArray(this.state.pendingUnbans) ? this.state.pendingUnbans : []
  }

  dropPendingUnban(uid) {
    this.state.pendingUnbans = (this.state.pendingUnbans || []).filter((x) => String(x.uid) !== String(uid))
    this.saveState()
  }

  readSnapshotFile() {
    try {
      const files = fs
        .readdirSync(this.snapshotDir)
        .filter((name) => name.toLowerCase().endsWith('.jpg'))
        .map((name) => path.join(this.snapshotDir, name))
      if (files.length === 0) return null
      files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      return files[0]
    } catch {
      return null
    }
  }
}
