import fs from 'node:fs'
import path from 'node:path'
import { clip, now } from './util.js'

const DESCRIBE_SYSTEM = `你在帮一个直播间房管看画面。只看画面，说人话。
输出一句话，20~40 个汉字，口语，不要用「图片」「画面中」这种词开头，不要编号，不要猜测观众人数或房间号。
说清楚：主播在干什么（打游戏/聊天/唱歌/看视频等）、当前大概是什么内容、有没有值得房管注意的事（比如主播离开、画面卡住、出现不合适的画面）。`

export class Vision {
  constructor({ sidecar, store, brain, logger, getConfig }) {
    this.sidecar = sidecar
    this.store = store
    this.brain = brain
    this.logger = logger
    this.getConfig = getConfig
    this.last = null
    this.busy = false
  }

  enabled() {
    return !!this.getConfig().vision?.enabled
  }

  snapshotDir() {
    return this.store.snapshotDir
  }

  /** 每小时最多抓几张，防止把画面感知当视频流刷。 */
  budgetLeft() {
    const max = Math.max(1, Number(this.getConfig().vision?.maxPerHour) || 6)
    const cutoff = now() - 3_600_000
    const used = this.store.recentActions(200).filter((item) => item.kind === 'snapshot' && item.ts >= cutoff && item.ok).length
    return Math.max(0, max - used)
  }

  snapshotUrl(filePath) {
    const name = path.basename(String(filePath || ''))
    return `/dafeiyu-moderator/api/snapshot/latest.jpg?t=${Date.now()}&f=${encodeURIComponent(name)}`
  }

  async capture({ force = false } = {}) {
    if (!force && this.budgetLeft() <= 0) throw new Error('这一小时的截图额度用完了，等会儿再看')
    const data = await this.sidecar.request(
      'snapshot',
      { outDir: this.snapshotDir() },
      70_000,
    )
    const snapshot = {
      path: data.path,
      url: this.snapshotUrl(data.path),
      timestamp: data.timestamp || now(),
      bytes: data.bytes || 0,
      elapsedMs: data.elapsedMs || 0,
    }
    this.last = snapshot
    this.store.bump('visionCalls')
    this.store.pushAction({ kind: 'snapshot', ok: true, reason: `${snapshot.bytes} 字节`, text: path.basename(snapshot.path) })
    return snapshot
  }

  async describe(snapshot) {
    if (!snapshot?.path) throw new Error('还没有截图')
    if (!this.brain.available()) throw new Error('没有可用模型，看不了画面')
    let data
    try {
      data = fs.readFileSync(snapshot.path)
    } catch (error) {
      throw new Error(`读截图失败：${error.message}`)
    }
    const result = await this.brain.complete({
      system: DESCRIBE_SYSTEM,
      user: `这是刚刚拍的直播画面。用一句话告诉我画面里在发生什么。`,
      images: [{ data, mediaType: 'image/jpeg', name: path.basename(snapshot.path) }],
      temperature: 0.4,
      maxTokens: 600,
      effort: this.getConfig?.()?.llm?.effort || 'low',
      timeoutMs: 45_000,
    })
    const text = clip(result.text.replace(/\s+/g, ' ').trim(), 200)
    if (!text) throw new Error('模型没说出画面内容')
    const scene = { at: now(), text, snapshot: snapshot.path, url: snapshot.url }
    this.store.setLastScene(scene)
    this.store.pushAction({ kind: 'snapshot', ok: true, reason: 'AI 看画面', text })
    return scene
  }

  /** 看一眼画面：截图 + 描述，任何一步失败都不抛给上层致死。 */
  async look({ force = false, describe = true } = {}) {
    if (this.busy) throw new Error('上一次看画面还没结束')
    this.busy = true
    try {
      const snapshot = await this.capture({ force })
      if (!describe) return { snapshot, scene: null }
      try {
        const scene = await this.describe(snapshot)
        return { snapshot, scene }
      } catch (error) {
        this.logger.warn(`画面描述失败：${error.message}`)
        this.store.pushAction({ kind: 'snapshot', ok: false, reason: clip(error.message, 120) })
        return { snapshot, scene: null, describeError: error.message }
      }
    } finally {
      this.busy = false
    }
  }

  latestScene() {
    return this.store.lastScene()
  }
}
