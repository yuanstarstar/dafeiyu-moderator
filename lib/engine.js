import {
  clip,
  extractJson,
  formatClock,
  normalizeText,
  now,
  pick,
  randInt,
  sleep,
} from './util.js'
import {
  buildDecisionPrompt,
  buildReviewPrompt,
  CATEGORY_LABEL,
  formatEventLine,
  pickTemplate,
  systemPrompt,
} from './persona.js'
import { categoryLabel, isWhitelisted, judge, TextHistory } from './moderate.js'

const EVENT_TYPES = new Set(['danmaku', 'gift', 'sc', 'enter', 'follow', 'share', 'live', 'view'])
const ANCHOR_TRIGGER = /^@?(大肥鱼|肥鱼)[，,：:\s]+/

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function pickText(item) {
  if (!item) return ''
  if (typeof item === 'string') return item
  return normalizeText(item.text || '')
}

function inQuietHours(config) {
  const quiet = config.quietHours || {}
  if (!quiet.enabled) return false
  const parse = (value) => {
    const [h, m] = String(value || '0:0').split(':').map((n) => Number(n) || 0)
    return h * 60 + m
  }
  const date = new Date()
  const cur = date.getHours() * 60 + date.getMinutes()
  const start = parse(quiet.start)
  const end = parse(quiet.end)
  if (start === end) return false
  return start < end ? cur >= start && cur < end : cur >= start || cur < end
}

export class Engine {
  constructor({ ctx, store, sidecar, brain, vision, logger }) {
    this.ctx = ctx
    this.store = store
    this.sidecar = sidecar
    this.brain = brain
    this.vision = vision
    this.logger = logger
    this.started = false
    this.startedAt = 0
    this.tickTimer = null
    this.chatTimer = null
    this.greetTimer = null
    this.history = new TextHistory()
    this.buffer = []
    this.lastActivityAt = 0
    this.selfLines = []
    this.connectedAt = 0
    this.lastEventAt = 0
    this.reconnects = 0
    this.lastSayAt = 0
    this.sayWindow = []
    this.lastModerateAt = 0
    this.moderateByUid = new Map()
    this.pendingModeration = []
    this.busyChat = false
    this.busyModerate = false
    this.nextChatAt = 0
    this.lastVisionAt = 0
    this.lastSkipActionAt = 0
    this.chatFocus = null
    this.mentionFocus = null
    this.lastMentionReplyAt = new Map()
    this.room = { roomId: 0, title: '', anchor: '', anchorUid: 0, liveStatus: 0, online: 0 }
    this.lastUnbanSweepAt = 0
    this.lastGiftSayAt = 0
    this.lastEnterSayAt = 0
    this.liveAnnounced = 0
    this.lastError = ''
    this.lastModelError = ''
    this.lastChatAt = 0
    this.lastChatResult = ''
    this.lastFallbackAt = 0
    this.speech = []
    this.speechCount = 0
    this.lastSpeechAt = 0
    this.lastNameReplyAt = 0
  }

  // ---------------------------------------------------------------- 生命周期

  async start() {
    const config = this.store.config
    if (!Number(config.roomId)) throw new Error('先在设置里填直播间号（roomId）')
    await this.sidecar.start()
    await this.sidecar.configure({
      roomId: Number(config.roomId),
      cookieFile: this.store.credentialPath(),
      ffmpegPath: config.ffmpegPath || '',
      snapshotDir: this.store.snapshotDir,
      maxDanmakuPerSec: 20,
      asrEnabled: !!config.asr?.enabled,
      asrModelDir: config.asr?.modelDir || '',
      asrLanguage: config.asr?.language || 'zh',
      asrMinSpeechSec: Number(config.asr?.minSpeechSec) || 0.6,
      asrGapSec: Number(config.asr?.gapSec) || 1.2,
      asrMaxPerMinute: Number(config.asr?.maxPerMinute) || 30,
    })
    const data = await this.sidecar.request('start', { roomId: Number(config.roomId) }, 40_000)
    this.room = { ...this.room, ...(data?.status?.room || {}) }
    this.started = true
    this.startedAt = now()
    this.connectedAt = 0
    this.lastEventAt = now()
    this.nextChatAt = now() + randInt(20_000, 45_000)
    this.#startTick()
    this.store.pushEvent({ type: 'system', ts: now(), note: `开工了，盯房间 ${config.roomId}` })
    this.store.pushAction({ kind: 'system', ok: true, text: `开始监听 ${config.roomId}` })
    this.logger.info(`AI 房管已开工 room=${config.roomId}`)
    this.#greetOnStart()
    return this.status()
  }

  /** 连上之后先吱一声：能听到它说话，就知道整条链路是通的。 */
  #greetOnStart() {
    if (this.greetTimer) clearTimeout(this.greetTimer)
    this.greetTimer = setTimeout(() => {
      const config = this.store.config
      const master = config.persona?.masterName || '主人'
      const line = pick(['来了来了，我盯着呢', '开门了开门了，今天这场我盯', `到位，${master}你忙你的`])
      this.#queueSay(line, { reason: '刚上班，打个招呼', kind: 'say' }).catch(() => {})
    }, 6_000)
    if (typeof this.greetTimer.unref === 'function') this.greetTimer.unref()
  }

  /** 扫码登录换了凭证：正在盯直播间就重连一遍，新凭证立刻生效。 */
  async reconnectAfterLogin() {
    if (!this.started) return { ok: true, skipped: '还没上班' }
    this.store.pushEvent({ type: 'system', ts: now(), note: '登录凭证更新了，重连直播间' })
    try {
      await this.stop()
    } catch (error) {
      this.logger?.warn?.(`登录后停止旧连接出错：${error.message || error}`)
    }
    await sleep(800)
    try {
      await this.start()
      this.store.pushAction({ kind: 'system', ok: true, text: '登录后重连成功' })
      return { ok: true }
    } catch (error) {
      const message = clip(error?.message || error, 200)
      this.lastError = message
      this.store.pushAction({ kind: 'skip', ok: false, reason: `登录后重连失败：${message}` })
      return { ok: false, error: message }
    }
  }

  async stop() {
    this.started = false
    this.#stopTick()
    try {
      await this.sidecar.request('stop', {}, 15_000)
    } catch (error) {
      this.logger.warn(`停止监听失败：${error.message}`)
    }
    this.store.pushEvent({ type: 'system', ts: now(), note: '收工了' })
    this.store.pushAction({ kind: 'system', ok: true, text: '停止监听' })
    return this.status()
  }

  async shutdown() {
    this.#stopTick()
    this.started = false
    await this.sidecar.stop()
  }

  #startTick() {
    this.#stopTick()
    this.tickTimer = setInterval(() => {
      this.#tick().catch((error) => this.logger.warn(`调度出错：${error.message}`))
    }, 1000)
    if (typeof this.tickTimer.unref === 'function') this.tickTimer.unref()
  }

  #stopTick() {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null
    if (this.chatTimer) clearTimeout(this.chatTimer)
    this.chatTimer = null
    if (this.greetTimer) clearTimeout(this.greetTimer)
    this.greetTimer = null
  }

  // ------------------------------------------------------------------ 状态

  status() {
    const config = this.store.config
    const py = this.sidecar.status()
    const connected = !!(this.started && py.running && this.lastEventAt && now() - this.lastEventAt < 180_000)
    const block = this.speakBlock()
    return {
      running: this.started,
      enabled: !!config.enabled,
      dryRun: !!config.dryRun,
      room: { ...this.room, roomId: Number(config.roomId) || this.room.roomId },
      conn: {
        connected,
        since: this.connectedAt || (connected ? this.startedAt : null),
        lastEventAt: this.lastEventAt || null,
        reconnects: this.reconnects,
      },
      python: py,
      counts: this.store.counters(),
      speak: {
        pausedUntil: this.store.speakPausedUntil() || null,
        canSay: !block,
        block,
        lastSayAt: this.lastSayAt || null,
        nextChatAt: this.nextChatAt || null,
        lastChatAt: this.lastChatAt || null,
        lastChatResult: this.lastChatResult || '',
        chatIntervalSec: Math.max(30, Number(config.speak?.chatIntervalSec) || 75),
      },
      llm: { ...this.brain.describe(), calls: this.store.counters().llmCalls, lastCallAt: this.brain.lastCallAt, lastError: this.brain.lastError || this.lastError },
      speakEnabled: !!(config.enabled && config.speak?.enabled),
      moderationOn: !!config.moderation?.enabled,
      speech: {
        enabled: !!config.asr?.enabled,
        count: this.speechCount,
        lastAt: this.lastSpeechAt || null,
        last: this.speech.length > 0 ? this.speech[this.speech.length - 1] : null,
      },
    }
  }

  // -------------------------------------------------------------- 侧车事件

  async handleEvent(event) {
    if (!event || !event.event) return
    const kind = String(event.event)
    if (kind === 'ready') {
      this.connectedAt = now()
      this.reconnects = Math.max(0, this.reconnects - 1)
      if (event.room) this.room = { ...this.room, ...event.room }
      this.store.pushEvent({ type: 'system', ts: now(), note: `已连上直播间 ${this.room.roomId || ''}` })
      return
    }
    if (kind === 'log') {
      this.logger.info(`侧车：${clip(event.message, 200)}`)
      return
    }
    if (kind === 'error') {
      this.lastError = clip(event.message || '侧车报错', 200)
      this.logger.warn(`侧车错误：${this.lastError}`)
      this.store.pushEvent({ type: 'system', ts: now(), note: this.lastError })
      return
    }
    if (kind === 'self-said') {
      const text = normalizeText(event.text || '')
      if (text) {
        this.selfLines.push(text)
        if (this.selfLines.length > 20) this.selfLines.shift()
        this.store.pushEvent({ type: 'danmaku', ts: now(), uid: 0, name: this.store.config.persona?.name || '大肥鱼', text, self: true })
      }
      return
    }
    if (kind === 'speech') {
      const text = normalizeText(event.text || '')
      if (!text) return
      this.speechCount += 1
      this.lastSpeechAt = now()
      const line = { text: clip(text, 120), dur: Number(event.dur) || 0, at: Number(event.ts) || now() }
      this.speech.push(line)
      if (this.speech.length > 12) this.speech.shift()
      this.lastEventAt = now()
      if (!this.connectedAt) this.connectedAt = now()
      this.store.pushEvent({ type: 'speech', ts: line.at, text: line.text, dur: line.dur })
      if (this.started) this.#onSpeech(line)
      return
    }
    if (!EVENT_TYPES.has(kind)) return

    this.lastEventAt = now()
    if (!this.connectedAt) this.connectedAt = now()

    if (kind === 'view') {
      if (Number(event.viewers) > 0) this.room.online = Number(event.viewers)
      this.store.pushEvent({ type: 'view', ts: now(), viewers: this.room.online })
      return
    }
    if (kind === 'live') {
      this.room.liveStatus = Number(event.liveStatus) || 0
      this.store.pushEvent({ type: 'live', ts: now(), liveStatus: this.room.liveStatus, note: event.note || '' })
      this.store.pushAction({ kind: 'system', ok: true, text: event.note || '直播状态变化' })
      if (this.liveAnnounced !== this.room.liveStatus) {
        this.liveAnnounced = this.room.liveStatus
        this.#queueSay(
          this.room.liveStatus ? '来了来了，今天这场我盯着' : '下播啦，辛苦啦，明天见',
          { reason: '直播状态', kind: 'say' },
        ).catch(() => {})
      }
      return
    }

    // B 站会把自己发的弹幕也推回来；宿主这边已经记过一遍「自己说的话」，别再当观众弹幕记第二次
    if (kind === 'danmaku' && now() - (this.lastSayAt || 0) < 25_000) {
      const echo = normalizeText(event.text || '')
      if (echo && this.selfLines.slice(-3).some((line) => normalizeText(line) === echo)) return
    }

    const payload = {
      type: kind,
      ts: Number(event.ts) || now(),
      uid: Number(event.uid) || 0,
      name: event.name || '',
      text: event.text || '',
      giftName: event.giftName || '',
      num: Number(event.num) || 1,
      price: Number(event.price) || 0,
      owner: !!event.owner,
      admin: !!event.admin,
      medal: Number(event.medal) || 0,
      medalName: event.medalName || '',
    }
    this.store.pushEvent(payload)
    // 任何「有人动了一下」都算动静：判断直播间是不是真的没人说话时用它
    if (kind === 'danmaku' || kind === 'gift' || kind === 'sc' || kind === 'enter' || kind === 'follow' || kind === 'speech') {
      this.lastActivityAt = payload.ts || now()
      if (kind !== 'danmaku') {
        this.buffer.push(payload)
        if (this.buffer.length > 160) this.buffer.shift()
      }
    }
    if (!this.started) return

    if (kind === 'danmaku') {
      this.#onDanmaku(payload)
    } else if (kind === 'gift') {
      this.store.bump('gifts')
      this.#onGift(payload).catch((error) => this.logger.warn(`谢礼物失败：${error.message}`))
    } else if (kind === 'sc') {
      this.store.bump('sc')
      this.#onSuperChat(payload).catch((error) => this.logger.warn(`回醒目留言失败：${error.message}`))
    } else if (kind === 'enter' || kind === 'follow') {
      this.store.bump(kind === 'enter' ? 'enters' : 'follows')
      this.#onEnter(payload).catch(() => {})
    }
  }

  #onDanmaku(payload) {
    this.store.bump('danmaku')
    // 历史弹幕接口不带身份，主播自己说话会被当成普通观众；用房间里的主播 uid 兜一下
    if (!payload.owner && this.room?.anchorUid && Number(payload.uid) === Number(this.room.anchorUid)) {
      payload.owner = true
    }
    this.history.add(payload.uid, payload.text, payload.ts)
    this.buffer.push(payload)
    if (this.buffer.length > 160) this.buffer.shift()
    const config = this.store.config

    // 主播/房管点名：优先处理
    const command = this.#matchCommand(payload, config)
    if (command !== null) {
      this.runAnchor(payload, command).catch((error) => this.logger.warn(`执行点名指令失败：${error.message}`))
      return
    }

    // 观众 @我 / 喊我名字：不等调度，马上回一句（不再只认主播和房管）
    if (this.#mentionsBot(payload, config)) {
      const uid = String(payload.uid || 0)
      if (now() - (this.lastMentionReplyAt.get(uid) || 0) > 8_000) {
        this.lastMentionReplyAt.set(uid, now())
        if (this.lastMentionReplyAt.size > 200) this.lastMentionReplyAt.clear()
        this.#replyNow(payload)
      }
    }

    // 主播说话：给一点反应（不是每条都接）
    if (config.speak?.replyToAnchor && payload.owner && payload.text && Math.random() < 0.6) {
      this.chatFocus = this.chatFocus || payload
      this.nextChatAt = Math.min(this.nextChatAt || now(), now() + randInt(4_000, 10_000))
    }

    // 违规初筛
    if (!config.moderation?.enabled || isWhitelisted(payload, config)) return
    const verdict = judge(payload, { config, history: this.history })
    if (!verdict) return
    this.#enqueueModeration(payload, verdict)
  }

  /** 这条弹幕是不是在叫我（@名字 / 带名字 / 单独喊「肥鱼」）。 */
  #mentionsBot(payload, config) {
    const text = normalizeText(payload.text)
    if (!text) return false
    const name = config.persona?.name || '大肥鱼'
    if (text.includes(name) || text.includes('肥鱼')) return true
    const short = name.replace(/^大/, '')
    return short.length >= 2 && text.includes(short)
  }

  /** 有人在弹幕里喊我：立刻接一句，不等 1 秒 tick 的闲聊档期。 */
  #replyNow(payload) {
    this.chatFocus = payload
    this.mentionFocus = payload
    if (this.busyChat) {
      this.nextChatAt = now()
      return
    }
    this.busyChat = true
    this.runChat()
      .catch((error) => this.logger.warn(`接话失败：${error.message}`))
      .finally(() => {
        this.busyChat = false
      })
  }

  #onSpeech(line) {
    this.store.bump('speech')
    const config = this.store.config
    const asr = config.asr || {}
    const text = line.text
    if (!text) return
    const name = config.persona?.name || '大肥鱼'
    const mentions = text.includes(name) || text.includes('肥鱼')
    // 主播喊名字：接一句（别太勤，90 秒最多一次）
    if (mentions && asr.reactToName !== false && now() - this.lastNameReplyAt > 90_000) {
      const replies = [
        '我在，听着呢',
        '在的在的，你说',
        '喊我了？到！',
        '听见了听见了',
      ]
      const pickReply = replies[randInt(0, replies.length - 1)]
      this.lastNameReplyAt = now()
      this.#queueSay(pickReply, { reason: `主播语音提到「${clip(text, 20)}」`, kind: 'say' }).catch(() => {})
      return
    }
    // 主播在说话：给闲聊一点驱动，别只在弹幕里找话
    if (config.speak?.replyToAnchor && Math.random() < 0.35) {
      this.nextChatAt = Math.min(this.nextChatAt || now(), now() + randInt(4_000, 10_000))
    }
  }

  #matchCommand(payload, config) {
    if (!payload.owner && !payload.admin) return null
    const text = normalizeText(payload.text)
    if (!text) return null
    const botName = config.persona?.name || '大肥鱼'
    const names = [botName, '大肥鱼', '肥鱼'].filter((n, i, arr) => n && arr.indexOf(n) === i)
    // @名字 在句中出现也算（B 站 @ 后面不一定带空格）
    for (const name of names) {
      const at = text.indexOf(`@${name}`)
      if (at >= 0) {
        return text.slice(at + 1 + name.length).replace(/^[:：,，\s]+/, '').trim()
      }
    }
    for (const name of names) {
      if (text.startsWith(name)) return text.slice(name.length).replace(/^[:：,，\s]+/, '').trim()
    }
    if (ANCHOR_TRIGGER.test(text)) return text.replace(ANCHOR_TRIGGER, '').trim()
    if (/^(看看|禁言|解禁|提醒|说|歇会|上班|下班)/.test(text)) return text
    return null
  }

  #enqueueModeration(payload, verdict) {
    const uid = String(payload.uid)
    const last = this.moderateByUid.get(uid) || 0
    if (now() - last < 8_000) return
    this.moderateByUid.set(uid, now())
    this.pendingModeration.push({ event: payload, verdict, at: now() })
    if (this.pendingModeration.length > 6) this.pendingModeration.shift()
  }

  // ------------------------------------------------------------------ 说话

  canSay({ priority = false } = {}) {
    const config = this.store.config
    if (!config.enabled || !config.speak?.enabled) return false
    if (inQuietHours(config)) return false
    if (this.store.speakPausedUntil() > now()) return false
    // 提醒/禁言要留出最低间隔（B 站本身限制 5 秒），但不受每分钟闲聊配额限制
    const gap = priority ? 5 : Math.max(5, Number(config.speak.minGapSec) || 15)
    if (now() - this.lastSayAt < gap * 1000) return false
    if (!priority) {
      const cutoff = now() - 60_000
      this.sayWindow = this.sayWindow.filter((ts) => ts >= cutoff)
      if (this.sayWindow.length >= Math.max(1, Number(config.speak.maxPerMinute) || 4)) return false
    }
    if (!this.sidecar.running) return false
    return true
  }

  /** 现在为什么不能说话（空字符串＝能说）。面板上「说话」那一行直接显示这个原因。 */
  speakBlock() {
    const config = this.store.config
    if (!config.enabled) return '总开关关着'
    if (!config.speak?.enabled) return '「允许主动说话」关着'
    if (inQuietHours(config)) return '现在在免打扰时段内'
    if (this.store.speakPausedUntil() > now()) return `被暂停说话（还剩 ${Math.ceil((this.store.speakPausedUntil() - now()) / 60_000)} 分钟）`
    if (!this.sidecar.running) return '侧车没连上直播间'
    const gap = Math.max(5, Number(config.speak.minGapSec) || 15)
    const wait = gap * 1000 - (now() - this.lastSayAt)
    if (wait > 0) return `刚说过话，还要等 ${Math.ceil(wait / 1000)} 秒`
    const minute = this.sayWindow.filter((ts) => ts >= now() - 60_000)
    if (minute.length >= Math.max(1, Number(config.speak.maxPerMinute) || 4)) return '这一分钟说得够多了'
    return ''
  }

  #sanitizeSay(text) {
    const config = this.store.config
    let out = normalizeText(String(text || '').replace(/[\r\n]+/g, ' '))
    out = out.replace(/\s{2,}/g, ' ').trim()
    const limit = Math.min(40, Math.max(6, Number(config.speak?.maxChars) || 20))
    if ([...out].length > limit) out = [...out].slice(0, limit).join('')
    return out
  }

  isRepeated(text) {
    const target = normalizeText(text)
    return this.selfLines.slice(-4).some((line) => normalizeText(line) === target)
  }

  async say(text, { replyToUid = 0, replyName = '', kind = 'say', reason = '', force = false, priority = false } = {}) {
    const target = Number(replyToUid) || 0
    // 面板/日志里希望看到「@谁 正文」，方便对着台账查
    const withAt = target && replyName ? this.#ensureAt(String(text || ''), replyName) : String(text || '')
    // 发到直播间时正文里不能再带 @：带了 replyMid 之后，客户端自己会渲染一个 @昵称，
    // 正文再写一遍就会变成「@某某 @某某 正文」（真机反馈里那一屏就是这么来的）。
    const outgoing = target ? this.#stripLeadingAt(withAt) : withAt
    const cleaned = this.#sanitizeSay(outgoing) || this.#sanitizeSay(withAt)
    const display = this.#sanitizeSay(withAt) || cleaned
    if (!cleaned) return { ok: false, error: '弹幕内容为空' }
    if (!force && this.isRepeated(cleaned)) {
      this.store.pushAction({ kind: 'skip', ok: false, reason: '重复了上一句，跳过', text: display })
      return { ok: false, error: '和刚说过的话重复，已跳过' }
    }
    if (!force && !this.canSay({ priority })) {
      this.store.pushAction({ kind: 'skip', ok: false, reason: '被限流/暂停/免打扰挡住', text: display })
      return { ok: false, error: '现在不该说话（频率/暂停/免打扰）' }
    }
    let result
    try {
      result = await this.sidecar.request('say', { text: cleaned, ...(target ? { replyMid: target } : {}) }, 25_000)
    } catch (error) {
      if (target) {
        try {
          result = await this.sidecar.request('say', { text: cleaned }, 25_000)
        } catch (retryError) {
          this.store.pushAction({ kind: 'say', ok: false, reason: clip(retryError.message, 120), text: display })
          return { ok: false, error: retryError.message }
        }
      } else {
        this.store.pushAction({ kind: 'say', ok: false, reason: clip(error.message, 120), text: display })
        return { ok: false, error: error.message }
      }
    }
    this.lastSayAt = now()
    this.sayWindow.push(this.lastSayAt)
    // 去重/回声识别比对的是「真正发出去的那段字」，B 站会原样回推
    this.selfLines.push(cleaned)
    if (this.selfLines.length > 20) this.selfLines.shift()
    this.store.bump('says')
    this.store.pushEvent({ type: 'danmaku', ts: now(), uid: 0, name: this.store.config.persona?.name || '大肥鱼', text: display, self: true })
    this.store.pushAction({ kind, ok: true, text: display, reason: reason || '', uid: target || undefined })
    return { ok: true, text: display, sent: cleaned, result }
  }

  // 提醒/禁言这种话必须发出去，不能被「刚说过话」「这句重复」这类礼貌性限流吞掉。
  // 先按正常规矩发；万一被挡，等一秒半再强行发一次（force 跳过重复与频率检查）。
  async #sayUrgent(text, options = {}) {
    const first = await this.say(text, options)
    if (first.ok) return first
    const soft = /重复|不该说话/.test(String(first.error || ''))
    if (!soft) return first
    await sleep(1500)
    const second = await this.say(text, { ...options, force: true })
    return second.ok ? second : first
  }

  async #queueSay(text, { replyToUid = 0, replyName = '', reason = '', kind = 'say' } = {}) {
    if (!this.canSay()) {
      this.store.pushAction({ kind: 'skip', ok: false, reason: `想说话但被限流：${clip(text, 30)}`, text: '' })
      return false
    }
    const result = await this.say(text, { replyToUid, replyName, reason, kind })
    return result.ok
  }

  // ------------------------------------------------------------ 礼物/进场

  async #onGift(payload) {
    const config = this.store.config
    if (!config.speak?.reactToGift || !config.speak?.enabled) return
    if (now() - this.lastGiftSayAt < 20_000) return
    if (payload.price > 0 && payload.price < 100 && Math.random() < 0.7) return
    this.lastGiftSayAt = now()
    const text = pickTemplate('gift', null, { name: payload.name || '老板', gift: payload.giftName || '礼物' })
    await this.#queueSay(text, { replyToUid: payload.uid, reason: `谢礼物 ${payload.giftName}`, kind: 'say' })
  }

  async #onSuperChat(payload) {
    if (!this.store.config.speak?.enabled) return
    if (now() - this.lastGiftSayAt < 12_000) return
    this.lastGiftSayAt = now()
    const text = pickTemplate('sc', null, { name: payload.name || '老板' })
    await this.#queueSay(text, { replyToUid: payload.uid, reason: '回醒目留言', kind: 'say' })
  }

  async #onEnter(payload) {
    const config = this.store.config
    if (!config.speak?.greetEnter || !config.speak?.enabled) return
    if (now() - this.lastEnterSayAt < 120_000) return
    if (Math.random() < 0.85) return
    this.lastEnterSayAt = now()
    await this.#queueSay(pickTemplate('greet', null, { name: payload.name || '新朋友' }), { reason: '欢迎进场', kind: 'say' })
  }

  // -------------------------------------------------------------- 提醒/禁言

  /** 确保是「@某人 正文」，B 站弹幕里直接 @ 昵称最直观，reply_mid 再加一层回复关系。 */
  #ensureAt(text, displayName) {
    const raw = String(text || '').trim()
    const name = String(displayName || '').trim()
    if (!raw) return name ? `@${name}` : ''
    if (!name || raw.startsWith('@')) return raw
    return `@${name} ${raw}`
  }

  /**
   * 去掉正文开头那个「@昵称」。
   * 带 replyMid 发弹幕时，B 站客户端会自己渲染一个 @昵称，
   * 正文再写一遍就重复成「@某某 @某某 正文」。
   */
  #stripLeadingAt(text) {
    const raw = String(text || '').trim()
    if (!raw.startsWith('@')) return raw
    const rest = raw.replace(/^@[^\s@]{1,32}[\s,，:：、]*/, '').trim()
    return rest || raw
  }

  async warn(uid, { name = '', reason = '', text = '', category = 'default', source = 'manual', urgent = false } = {}) {
    const config = this.store.config
    if (!Number(uid)) return { ok: false, error: 'uid 无效' }
    if (!config.moderation?.enabled) return { ok: false, error: '自动管控已关闭' }
    if (isWhitelisted({ uid: Number(uid), name }, config)) return { ok: false, error: '这个人在白名单里，不动他' }
    const displayName = name || this.store.ledgerGet(uid).name || `用户${uid}`
    const raw = text ? text : pickTemplate('warn', category, { name: displayName })
    const body = this.#sanitizeSay(this.#ensureAt(raw, displayName))
    const result = await this.#sayUrgent(body, { replyToUid: Number(uid), reason: reason || `提醒（${category}）`, kind: 'warn', priority: true, force: urgent })
    if (!result.ok) {
      this.store.pushAction({ kind: 'warn', ok: false, uid: Number(uid), name: displayName, text: body, reason: clip(result.error || '没发出去', 120) })
      return { ok: false, error: result.error, action: { kind: 'warn', uid: Number(uid), name: displayName, text: body, sent: false } }
    }
    this.store.recordWarn(uid, displayName, reason || categoryLabel(category), category)
    this.store.bump('warns')
    this.logger.info(`提醒 ${displayName}(${uid})：${body}`)
    return { ok: true, action: { kind: 'warn', uid: Number(uid), name: displayName, text: body, reason, category, source, sent: true } }
  }

  async mute(uid, { name = '', minutes = 5, reason = '', text = '', category = 'default', source = 'manual', urgent = false } = {}) {
    const config = this.store.config
    const id = Number(uid)
    if (!id) return { ok: false, error: 'uid 无效' }
    if (!config.moderation?.enabled) return { ok: false, error: '自动管控已关闭' }
    if (isWhitelisted({ uid: id, name }, config)) return { ok: false, error: '这个人在白名单里，不动他' }
    const displayName = name || this.store.ledgerGet(id).name || `用户${id}`
    const muteMinutes = Math.min(1440, Math.max(1, Number(minutes) || Number(config.moderation.muteMinutes) || 5))

    if (config.dryRun) {
      const raw = text ? text : pickTemplate('warn', category, { name: displayName })
      const body = this.#sanitizeSay(this.#ensureAt(raw, displayName))
      const said = await this.#sayUrgent(body, { replyToUid: id, reason: `演习：本该禁言 ${displayName} ${muteMinutes} 分钟`, kind: 'mute', priority: true, force: urgent })
      this.store.recordWarn(id, displayName, `[演习] ${reason || categoryLabel(category)}`, category)
      this.store.bump('warns')
      this.store.pushAction({ kind: 'mute', ok: true, uid: id, name: displayName, text: body, reason: `演习模式：本该禁言 ${muteMinutes} 分钟，只发了提醒` })
      return { ok: said.ok, action: { kind: 'mute', uid: id, name: displayName, dryRun: true, minutes: muteMinutes, reason } }
    }

    const hourly = this.#mutesWithinHour()
    const cap = Math.max(1, Number(config.moderation.maxMutesPerHour) || 5)
    if (hourly >= cap) {
      this.store.pushAction({ kind: 'mute', ok: false, uid: id, name: displayName, reason: `这一小时已经禁言 ${hourly} 次，到上限了` })
      return { ok: false, error: `这一小时禁言次数到上限了（${cap} 次）` }
    }

    const hour = Math.max(1, Math.ceil(muteMinutes / 60))
    try {
      await this.sidecar.request('ban', { uid: id, hour }, 30_000)
    } catch (error) {
      this.store.pushAction({ kind: 'mute', ok: false, uid: id, name: displayName, reason: clip(error.message, 140) })
      return { ok: false, error: `禁言失败：${error.message}` }
    }
    const until = now() + muteMinutes * 60_000
    const record = config.moderation?.autoUnban !== false
    this.store.recordMute(id, displayName, reason || categoryLabel(category), category, muteMinutes, record ? until : null)
    if (!record) this.store.dropPendingUnban(id)
    this.store.bump('mutes')
    const raw = text ? text : pickTemplate('mute', category, { name: displayName, m: muteMinutes })
    const body = this.#sanitizeSay(this.#ensureAt(raw, displayName))
    await this.#sayUrgent(body, { replyToUid: id, reason: `禁言 ${displayName} ${muteMinutes} 分钟：${reason}`, kind: 'mute', priority: true, force: urgent }).catch(() => {})
    this.logger.info(`禁言 ${displayName}(${id}) ${muteMinutes} 分钟：${reason}`)
    return {
      ok: true,
      action: { kind: 'mute', uid: id, name: displayName, minutes: muteMinutes, until, text: body, reason, category, source },
    }
  }

  #mutesWithinHour() {
    const cutoff = now() - 3_600_000
    return Object.values(this.store.state.ledger).reduce((sum, row) => {
      const hits = (row.notes || []).filter((note) => note.kind === 'mute' && note.at >= cutoff)
      return sum + hits.length
    }, 0)
  }

  async unban(uid, { announce = true, reason = '' } = {}) {
    const id = Number(uid)
    if (!id) return { ok: false, error: 'uid 无效' }
    try {
      await this.sidecar.request('unban', { uid: id }, 30_000)
    } catch (error) {
      this.store.pushAction({ kind: 'unban', ok: false, uid: id, reason: clip(error.message, 140) })
      return { ok: false, error: `解禁失败：${error.message}` }
    }
    const name = this.store.ledgerGet(id).name || `用户${id}`
    this.store.recordUnban(id)
    this.store.bump('unbans')
    this.store.pushAction({ kind: 'unban', ok: true, uid: id, name, reason: reason || '自动解禁', text: '' })
    if (announce) {
      await this.say(pickTemplate('unban', null, { name }), { replyToUid: id, reason: '解禁', kind: 'unban' }).catch(() => {})
    }
    return { ok: true, uid: id, name }
  }

  // ------------------------------------------------------------ 点名（主播）

  async runAnchor(payload, command) {
    const config = this.store.config
    const text = normalizeText(command)
    this.store.bump('llmCalls', 0)
    try {
      if (/^(看看|看下|画面|在播什么|在干嘛|播的什么)/.test(text) || text === '') {
        const { snapshot, scene, describeError } = await this.vision.look({ force: true })
        const body = scene?.text || (describeError ? '画面我拍到了，但没看清' : '画面拍到了')
        await this.say(body, { reason: '主播让看画面', kind: 'say' })
        return { ok: true, action: 'look', snapshot, scene }
      }
      const banMatch = text.match(/^(强制?)?禁言\s*(.+)$/)
      if (banMatch) {
        const target = this.#resolveUser(banMatch[2])
        if (!target) return { ok: false, error: `没找到「${banMatch[2]}」，说 uid 或者完整的昵称` }
        const result = await this.mute(target.uid, { name: target.name, minutes: config.moderation.muteMinutes, reason: '主播点名的', source: 'anchor' })
        return { ok: result.ok, ...result }
      }
      const warnMatch = text.match(/^(提醒|警告)\s*(.+)$/)
      if (warnMatch) {
        const target = this.#resolveUser(warnMatch[2])
        if (!target) return { ok: false, error: `没找到「${warnMatch[2]}」` }
        const result = await this.warn(target.uid, { name: target.name, reason: '主播点名的', source: 'anchor' })
        return { ok: result.ok, ...result }
      }
      const sayMatch = text.match(/^(说|念|发)\s*[：:]?\s*(.+)$/)
      if (sayMatch) {
        const result = await this.say(sayMatch[2], { reason: '主播让我说的', kind: 'say' })
        return { ok: result.ok, ...result }
      }
      if (/(歇会|歇一会儿|闭嘴|安静|别说了|停一下|别吵)/.test(text)) {
        const until = now() + 10 * 60_000
        this.store.setSpeakPausedUntil(until)
        await this.say(pickTemplate('quiet'), { reason: '主播让闭嘴', kind: 'say' })
        return { ok: true, pausedUntil: until }
      }
      if (/(上班|开工|开始工作|看着点)/.test(text)) {
        this.store.patchConfig({ enabled: true })
        await this.say(pickTemplate('wake'), { reason: '主播让开工', kind: 'say' })
        return { ok: true }
      }
      if (/(下班|收工|休息吧)/.test(text)) {
        this.store.patchConfig({ enabled: false })
        await this.say('那我先撤，有事喊我', { reason: '主播让下班', kind: 'say', force: true })
        return { ok: true }
      }
      // 其他指令交给模型理解，但不许它乱禁言
      const prompt = buildDecisionPrompt({
        mode: 'anchor',
        config,
        events: this.store.recentEvents(12),
        focus: payload,
        ledgerRows: [],
        scene: this.vision.latestScene(),
        selfLines: this.selfLines,
        speechLines: this.speech.slice(-10),
        room: this.room,
        command: text,
      })
      const decision = await this.#askModel(prompt, 'anchor')
      await this.#applyDecision(decision, { mode: 'anchor', focus: payload })
      return { ok: true, decision }
    } catch (error) {
      this.logger.warn(`执行点名指令失败：${error.message}`)
      return { ok: false, error: error.message }
    }
  }

  #resolveUser(raw) {
    const text = normalizeText(raw).replace(/^@/, '').trim()
    if (!text) return null
    if (/^\d{4,}$/.test(text)) {
      const uid = Number(text)
      return { uid, name: this.store.ledgerGet(uid).name || `用户${uid}` }
    }
    const recent = this.store.recentEvents(120).filter((event) => event.uid)
    const exact = recent.find((event) => event.name === text)
    if (exact) return { uid: exact.uid, name: exact.name }
    const fuzzy = recent.find((event) => event.name && (event.name.includes(text) || text.includes(event.name)))
    if (fuzzy) return { uid: fuzzy.uid, name: fuzzy.name }
    const ledgerHit = Object.values(this.store.state.ledger).find((row) => row.name === text)
    if (ledgerHit) return { uid: ledgerHit.uid, name: ledgerHit.name }
    return null
  }

  // ---------------------------------------------------------------- 模型决策

  async #askModel(prompt, mode) {
    if (!this.brain.available()) throw new Error('没有可用模型')
    const result = await this.brain.complete({
      system: prompt.system,
      user: prompt.user,
      temperature: mode === 'moderate' ? 0.45 : 0.9,
      maxTokens: mode === 'moderate' ? 900 : 1400,
      // 闲聊不需要长思考：思考一长就把正文预算吃光，反而说不出话
      effort: this.store.config.llm?.effort || 'low',
      timeoutMs: 55_000,
    })
    this.store.bump('llmCalls')
    const parsed = extractJson(result.text)
    if (parsed) return parsed
    // 模型没按 JSON 回：闲聊这一轮就当它直接说了句话用上，别白调一次模型
    const plain = normalizeText(String(result.text || '').split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean)[0] || '')
    const usable = mode !== 'moderate' && plain && plain.length <= 80 && !plain.includes('{') && !plain.includes('}')
    return {
      think: usable ? '模型没按 JSON 回，直接当一句话用了' : clip(result.text, 120),
      say: usable ? [{ text: plain }] : [],
      warn: [],
      mute: [],
      raw: result.text,
    }
  }

  async #applyDecision(decision, { mode, focus, mention = false }) {
    const config = this.store.config
    const said = []
    const allowed = Array.isArray(decision?.say) ? decision.say.slice(0, 2) : []
    for (const item of allowed) {
      const text = this.#sanitizeSay(pickText(item))
      if (!text) continue
      const explicit = Number(item?.replyToUid) || 0
      const replyTo = explicit || (focus?.uid && (mode === 'anchor' || mention) ? focus.uid : 0)
      const replyName = replyTo && focus && Number(focus.uid) === Number(replyTo) ? focus.name : ''
      const result = await this.say(text, { replyToUid: replyTo, replyName, reason: mode === 'anchor' ? '回应点名' : '自由参与', kind: 'say', priority: mode === 'anchor' || mention })
      said.push(result)
      if (!result.ok) break
      if (this.canSay() === false) break
    }

    const touched = new Set()
    const muteUids = new Set(asArray(decision?.mute).map((item) => Number(item?.uid) || 0).filter(Boolean))
    // 这一轮已经决定要禁言的人，就别再单独提醒一遍了（禁言文案本身就是最后一次提醒）
    const warnedBeforeRound = new Map()
    for (const item of asArray(decision?.warn).slice(0, 1)) {
      const uid = Number(item?.uid) || 0
      if (!uid) continue
      if (muteUids.has(uid)) continue
      const name = item?.name || ''
      const reason = clip(item?.reason || categoryLabel(focus?.category), 60)
      const text = pickText(item)
      touched.add(uid)
      warnedBeforeRound.set(uid, this.store.warnsWithin(uid, config.moderation.windowMin))
      await this.warn(uid, { name, reason, text, category: focus?.category || 'default', source: mode })
    }

    const muteItems = asArray(decision?.mute).slice(0, 1)
    for (const item of muteItems) {
      const uid = Number(item?.uid) || 0
      if (!uid) continue
      const name = item?.name || ''
      const reason = clip(item?.reason || '多次提醒不改', 60)
      const text = pickText(item)
      // 用这一轮开始前的提醒次数判断，别把刚发出去的那条提醒算进去，否则同一轮又提醒又禁言
      const warned = warnedBeforeRound.has(uid) ? warnedBeforeRound.get(uid) : this.store.warnsWithin(uid, config.moderation.windowMin)
      const threshold = Math.max(1, Number(config.moderation.warnBeforeMute) || 2)
      const isAnchorOrder = mode === 'anchor'
      if (!isAnchorOrder && warned < threshold) {
        // 不够次数：模型想禁言也先降级成提醒；这一轮已经提醒过同一个人就不重复刷屏
        if (touched.has(uid)) continue
        touched.add(uid)
        await this.warn(uid, { name, reason: `${reason}（提醒 ${warned}/${threshold}，先不动手）`, text: '', category: focus?.category || 'default', source: mode })
        continue
      }
      await this.mute(uid, { name, minutes: config.moderation.muteMinutes, reason, text, category: focus?.category || 'default', source: mode })
    }
    return { said }
  }

  // ------------------------------------------------------------------ 调度

  async #tick() {
    if (!this.started) return
    // 1) 到点自动解禁
    if (now() - this.lastUnbanSweepAt > 15_000) {
      this.lastUnbanSweepAt = now()
      await this.#sweepUnbans()
    }
    // 2) 处理待办的违规
    if (!this.busyModerate && this.pendingModeration.length > 0 && now() - this.lastModerateAt > 6_000) {
      const item = this.pendingModeration.shift()
      this.lastModerateAt = now()
      this.busyModerate = true
      this.runModerate(item.event, item.verdict)
        .catch((error) => this.logger.warn(`管控判断失败：${error.message}`))
        .finally(() => {
          this.busyModerate = false
        })
    }
    // 3) 自由参与聊天
    const config = this.store.config
    const interval = Math.max(30, Number(config.speak?.chatIntervalSec) || 75) * 1000
    if (!this.busyChat && config.speak?.enabled && now() >= this.nextChatAt) {
      const block = this.speakBlock()
      if (block) {
        // 到点了但说不了：把原因留在状态里，面板一眼能看见卡在哪
        this.lastChatResult = `到点该接话了，但被挡住：${block}`
      } else if (this.canSay()) {
        const newest = this.buffer.length ? this.buffer[this.buffer.length - 1] : null
        const lastActivity = Number(this.lastActivityAt) || Number(newest?.ts) || 0
        const quietSec = lastActivity ? (now() - lastActivity) / 1000 : 0
        const lastSay = Number(this.lastSayAt) || 0
        const hasFresh = lastActivity > lastSay
        const quietLimit = Math.max(0, Number(config.speak?.quietAfterSec ?? 180))
        const called = !!this.chatFocus
        if (!called && (!hasFresh || (quietLimit > 0 && quietSec > quietLimit))) {
          // 直播间没什么动静：不浪费模型调用，也不自说自话
          this.lastChatResult = hasFresh ? '安静一阵了，先不硬接话' : '直播间没新动静，先不开口'
          this.nextChatAt = now() + interval
        } else {
          this.busyChat = true
          this.nextChatAt = now() + interval + randInt(-10_000, 20_000)
          this.runChat()
            .catch((error) => this.logger.warn(`闲聊失败：${error.message}`))
            .finally(() => {
              this.busyChat = false
            })
        }
      }
    }
    // 4) 定时看画面
    if (config.vision?.enabled && now() - this.lastVisionAt > Math.max(2, Number(config.vision.intervalMin) || 8) * 60_000) {
      this.lastVisionAt = now()
      if (this.vision.budgetLeft() > 0 && this.room.liveStatus !== 0) {
        this.vision
          .look({ describe: true })
          .catch((error) => this.logger.warn(`定时看画面失败：${error.message}`))
      }
    }
  }

  async #sweepUnbans() {
    const config = this.store.config
    if (config.moderation?.autoUnban === false) return
    const due = this.store.pendingUnbans().filter((row) => Number(row.at) > 0 && Number(row.at) <= now())
    for (const row of due) {
      try {
        await this.sidecar.request('unban', { uid: Number(row.uid) }, 20_000)
        this.store.recordUnban(row.uid)
        this.store.bump('unbans')
        this.store.pushAction({ kind: 'unban', ok: true, uid: Number(row.uid), name: row.name, reason: '到点自动解禁' })
        this.logger.info(`自动解禁 ${row.name || row.uid}`)
      } catch (error) {
        this.store.pushAction({ kind: 'unban', ok: false, uid: Number(row.uid), name: row.name, reason: clip(error.message, 140) })
        this.store.dropPendingUnban(row.uid)
      }
    }
  }

  async runChat() {
    const config = this.store.config
    const events = this.buffer.slice(-30)
    const focus = this.chatFocus
    const mention = !!focus && this.mentionFocus === focus
    this.chatFocus = null
    this.mentionFocus = null
    const newest = this.buffer.length ? this.buffer[this.buffer.length - 1] : null
    const lastActivity = Number(this.lastActivityAt) || Number(newest?.ts) || 0
    const quietSec = lastActivity ? Math.max(0, Math.round((now() - lastActivity) / 1000)) : 0
    const lastSay = Number(this.lastSayAt) || 0
    // 「新动静」＝上次说话之后才来的人/话/礼物；安静的时候不该硬找话说
    const fresh = lastSay ? this.buffer.filter((item) => Number(item.ts) > lastSay) : this.buffer.slice()
    const hasFresh = lastActivity > lastSay
    const quietLimit = Math.max(0, Number(config.speak?.quietAfterSec ?? 180))
    if (!focus) {
      if (!hasFresh) {
        this.lastChatResult = '直播间没新动静，先不开口'
        return { ok: true, skipped: '没有新动静' }
      }
      if (quietLimit > 0 && quietSec > quietLimit) {
        this.lastChatResult = `已经 ${Math.max(1, Math.round(quietSec / 60))} 分钟没人说话了，先安静待着`
        return { ok: true, skipped: '太久没人说话' }
      }
    }
    if (events.length === 0 && !focus) {
      this.lastChatResult = '没有新动静，先不开口'
      return { ok: true, skipped: '没有新动静' }
    }
    const prompt = buildDecisionPrompt({
      mode: 'chat',
      config,
      events,
      focus,
      ledgerRows: [],
      scene: this.vision.latestScene(),
      selfLines: this.selfLines,
      speechLines: this.speech.slice(-10),
      room: this.room,
      idleSec: this.lastSayAt ? now() - this.lastSayAt : 0,
      freshCount: focus ? Math.max(1, fresh.length) : fresh.length,
      quietSec,
    })
    this.lastChatAt = now()
    try {
      const decision = await this.#askModel(prompt, 'chat')
      const result = await this.#applyDecision(decision, { mode: 'chat', focus, mention })
      const saidCount = result.said.filter((item) => item && item.ok).length
      if (saidCount === 0) {
        // 模型这轮又没开口：确实有人在说话、而且晾太久了，才自己兜一句
        const idle = this.lastSayAt ? now() - this.lastSayAt : 0
        const lastEvent = events[events.length - 1]
        if (lastEvent && quietSec <= 120 && idle > 120_000 && now() - (this.lastFallbackAt || 0) > 180_000) {
          const line = this.#fallbackChatLine(lastEvent) || pickTemplate('fallback', null, { name: lastEvent.name || '大家' })
          if (line) {
            this.lastFallbackAt = now()
            const res = await this.say(line, { reason: '模型没开口，兜一句', kind: 'say' })
            if (res.ok) {
              result.said.push(res)
              this.lastChatResult = '模型没开口，兜了一句'
            }
          }
        }
      }
      this.lastChatResult = result.said.filter((item) => item && item.ok).length > 0
        ? `说了 ${result.said.filter((item) => item && item.ok).length} 句`
        : this.lastChatResult || `模型这轮不想说（${clip(decision?.think || '没给理由', 60)}）`
      if (this.lastChatResult.startsWith('模型这轮不想说') && now() - this.lastSkipActionAt > 600_000) {
        this.lastSkipActionAt = now()
        this.store.pushAction({ kind: 'skip', ok: true, reason: clip(decision?.think || '这轮没值得接的话', 80), text: '' })
      }
      return { ok: true, said: result.said.length }
    } catch (error) {
      this.lastModelError = clip(error.message, 200)
      this.lastChatResult = `模型出错：${clip(error.message, 60)}`
      this.logger.warn(`闲聊模型调用失败：${error.message}`)
      this.store.pushAction({ kind: 'skip', ok: false, reason: `模型没回上话：${clip(error.message, 120)}` })
      if (this.canSay() && events.length > 0 && quietSec <= 120) {
        const fallback = this.#fallbackChatLine(events[events.length - 1])
        if (fallback) await this.say(fallback, { reason: '模型掉线时的兜底', kind: 'say' })
      }
      return { ok: false, error: error.message }
    }
  }

  #fallbackChatLine(event) {
    if (!event) return ''
    const masterName = this.store.config.persona?.masterName || '主人'
    if (event.owner) {
      // 主播（主人）说话但模型掉线了：至少吱一声，别晾着
      return pick(['嗯嗯，听着呢', '收到收到', `${masterName}你说`])
    }
    if (event.type === 'danmaku' && event.text && !event.self) {
      const at = event.name ? `@${event.name} ` : ''
      if (/[?？]$/.test(event.text)) return `${at}${pickTemplate('fallback')}`
      return `${at}${pick(['这波可以', '哈哈确实', '懂的都懂', '我看着呢', '有点东西'])}`
    }
    return ''
  }

  async runModerate(event, verdict) {
    const config = this.store.config
    const focus = {
      ...event,
      category: verdict.category,
      categoryLabel: CATEGORY_LABEL[verdict.category] || categoryLabel(verdict.category),
      verdictReason: verdict.reason,
    }
    const ledgerRows = (this.store.ledgerGet(event.uid).notes || []).slice(-6)
    const prompt = buildDecisionPrompt({
      mode: 'moderate',
      config,
      events: this.buffer.slice(-20),
      focus,
      ledgerRows,
      scene: this.vision.latestScene(),
      selfLines: this.selfLines,
      speechLines: this.speech.slice(-10),
      room: this.room,
    })
    let decision
    try {
      decision = await this.#askModel(prompt, 'moderate')
    } catch (error) {
      this.logger.warn(`管控模型调用失败，走规则兜底：${error.message}`)
      await this.warn(event.uid, {
        name: event.name,
        reason: verdict.reason,
        text: '',
        category: verdict.category,
        source: 'rule',
      })
      return { ok: false, error: error.message }
    }
    const warnedBefore = this.store.warnsWithin(event.uid, config.moderation.windowMin)
    const wantsMute = asArray(decision?.mute).length > 0
    // 模型不吭声但规则判定明显违规时，至少提醒一次
    if (!wantsMute && asArray(decision?.warn).length === 0 && verdict.score >= 85) {
      decision.warn = [{ uid: event.uid, name: event.name, reason: verdict.reason, text: '' }]
    }
    if (wantsMute && warnedBefore < 1 && verdict.score < 90) {
      decision.mute = []
    }
    const result = await this.#applyDecision(decision, { mode: 'moderate', focus })
    return { ok: true, said: result.said.length }
  }

  // ------------------------------------------------------------------ 复盘

  async review(minutes = 60) {
    const stats = {
      ...this.store.counters(),
      totals: this.store.totals(),
      room: this.room,
    }
    const actions = this.store.recentActions(80)
    const ledger = this.store.ledgerList(10)
    let text = ''
    try {
      const prompt = buildReviewPrompt({ stats, actions, ledger, minutes })
      const result = await this.brain.complete({
        system: prompt.system,
        user: prompt.user,
        temperature: 0.6,
        maxTokens: 700,
        effort: this.store.config.llm?.effort || 'low',
        timeoutMs: 50_000,
      })
      text = result.text
    } catch (error) {
      this.logger.warn(`复盘失败：${error.message}`)
      text = ''
    }
    if (!text) {
      const warns = actions.filter((item) => item.kind === 'warn').length
      const mutes = actions.filter((item) => item.kind === 'mute' && item.ok).length
      text = `${minutes} 分钟里收到弹幕 ${stats.danmaku} 条、礼物 ${stats.gifts} 次、醒目留言 ${stats.sc} 次；我提醒了 ${warns} 次、禁言 ${mutes} 次。模型现在没接上，先给个纯数字复盘。`
    }
    return {
      text,
      stats,
      minutes,
      actions: actions.slice(-20),
      at: now(),
    }
  }

  quietSummary() {
    return {
      started: this.started,
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      buffer: this.buffer.length,
      pending: this.pendingModeration.length,
      room: this.room,
      recent: this.store.recentEvents(40).map(formatEventLine).slice(-8),
    }
  }
}
