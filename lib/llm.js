import { randomUUID } from 'node:crypto'
import { clip } from './util.js'

/**
 * 模型对话封装：走宿主当前默认模型，不挑供应商。
 * 图片走 dsh-attachment 的 admitPromptContent，宿主没装 attachments 就退化成纯文字。
 *
 * ⚠️ sessionId 必须带：有的供应商（opencode-go）要求 x-opencode-session 头，
 * 不带就直接 400，而适配器会把它变成一个「没有正文」的 finish 块——看起来就像模型不说话。
 */
export class Brain {
  constructor({ ctx, logger, store }) {
    this.ctx = ctx
    this.logger = logger
    this.store = store
    this.sessionId = `dafeiyu-moderator-${randomUUID()}`
    this.lastCallAt = null
    this.lastError = ''
    this.lastText = ''
    this.lastModel = ''
    this.lastTries = 0
    this.calls = 0
  }

  available() {
    return !!(this.ctx.llm && typeof this.ctx.llm.stream === 'function' && this.ctx.agentDefaultModel)
  }

  selection() {
    try {
      const picked = this.ctx.agentDefaultModel.currentSelection()
      if (!picked || !picked.provider || !picked.model) return null
      return picked
    } catch {
      return null
    }
  }

  describe() {
    const picked = this.selection()
    return {
      available: this.available(),
      model: picked ? `${picked.provider}/${picked.model}` : '',
      calls: this.calls,
      lastCallAt: this.lastCallAt,
      lastError: this.lastError,
      lastText: this.lastText,
      lastTries: this.lastTries,
      effort: this.store?.config?.llm?.effort || 'low',
    }
  }

  async #parts(text, images) {
    const parts = []
    const admitted = []
    if (Array.isArray(images) && images.length > 0 && this.ctx.attachments?.admitPromptContent) {
      for (const image of images.slice(0, 2)) {
        try {
          const result = this.ctx.attachments.admitPromptContent([
            { type: 'image', data: image.data, mediaType: image.mediaType || 'image/jpeg', name: image.name || 'frame.jpg' },
          ])
          if (Array.isArray(result) && result.length > 0) admitted.push(...result)
        } catch (error) {
          this.logger.warn(`图片送不进模型：${error.message}`)
        }
      }
    }
    if (admitted.length > 0) {
      // 图片在前、说明在后，模型更容易把图和当前问题对上
      parts.push(...admitted)
    } else if (Array.isArray(images) && images.length > 0) {
      parts.push({ type: 'text', text: '（这次没拿到画面，只凭弹幕判断。）' })
    }
    parts.push({ type: 'text', text })
    return parts
  }

  /**
   * 调一次模型，返回纯文本。
   * 一句话为空就换一种发法再试：有些供应商/适配器对 system、reasoningEffort、
   * 内容块数组的支持不一致，硬试一种很容易「有调用、没正文」。
   * @returns {{text: string, elapsedMs: number, model: string, tries: number}}
   */
  async complete({ system, user, images = null, temperature = 0.85, maxTokens = 700, timeoutMs = 60_000, effort }) {
    if (!this.available()) throw new Error('当前没有可用的模型服务，检查 DSH 的模型设置')
    const picked = this.selection()
    if (!picked) throw new Error('读不到当前默认模型，去设置里选一个')
    const started = Date.now()
    const content = await this.#parts(user, images)
    // 'off' 表示完全不让模型思考；不传就让宿主按默认（通常是 max）来
    const wanted = effort === 'off' ? '' : effort === undefined ? picked.reasoningEffort : effort
    const requested = wanted === '' || wanted === undefined ? undefined : wanted
    const plainText = Array.isArray(content) ? content.map((part) => (part?.type === 'text' ? part.text : '')).join('\n') : String(user || '')
    const attempts = []
    // 第 1 次：按配置的思考等级 + 富内容块（正常情况）
    if (requested !== undefined && requested !== '') attempts.push({ label: 'effort', effort: requested, rich: true })
    else attempts.push({ label: 'rich', effort: undefined, rich: true })
    // 第 2 次：不要思考，内容块照旧
    attempts.push({ label: 'no-effort', effort: undefined, rich: true })
    // 第 3 次：退回最朴素的「一个字符串」，不带 system —— 适配器差异最大的地方
    attempts.push({ label: 'plain-text', effort: undefined, rich: false })

    let lastProblem = ''
    let tries = 0
    for (const attempt of attempts) {
      tries += 1
      const stats = { chunks: 0, text: 0, reasoning: 0, blockText: 0, error: 0, finish: 0, other: [] }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.max(5000, timeoutMs))
      if (typeof timer.unref === 'function') timer.unref()
      let text = ''
      let reasoning = ''
      try {
        const stream = this.ctx.llm.stream({
          provider: picked.provider,
          model: picked.model,
          sessionId: this.sessionId,
          ...(attempt.effort === undefined ? {} : { reasoningEffort: attempt.effort }),
          ...(attempt.rich ? { system } : {}),
          messages: [{ role: 'user', content: attempt.rich ? content : plainText }],
          temperature,
          maxTokens,
          signal: controller.signal,
        })
        for await (const chunk of stream) {
          if (!chunk) continue
          stats.chunks += 1
          if (chunk.type === 'text-delta') {
            stats.text += 1
            text += chunk.text || ''
            if (text.length > 20_000) break
          } else if (chunk.type === 'reasoning-delta') {
            // 有些模型会先把思考过程流出来；正文一片空白时，靠这个提示「token 被思考吃光了」
            stats.reasoning += 1
            reasoning += chunk.text || ''
          } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
            // 个别适配器不发增量、只在收尾时给整段文本
            stats.blockText += 1
            if (!text) text += chunk.block.text || ''
          } else if (chunk.type === 'error') {
            stats.error += 1
            throw new Error(chunk.error?.message || chunk.message || '模型返回错误')
          } else if (chunk.type === 'finish' || chunk.type === 'done') {
            stats.finish += 1
            const reason = chunk.reason ?? chunk.stopReason
            const kind = typeof reason === 'string' ? reason : reason?.kind
            const failure = reason && typeof reason === 'object' ? reason.failure || null : null
            if (kind === 'error' || kind === 'aborted') {
              // 适配器的真错误都藏在这个块里；不抛的话就变成一句「模型返回了空内容」
              stats.error += 1
              throw new Error(failure?.message || `模型调用失败（${failure?.code || kind}）`)
            }
            if (kind === 'max-tokens') {
              lastProblem = `输出额度用完了（maxTokens ${maxTokens}）：思考把 token 吃光了`
            }
            break
          } else if (stats.other.length < 6) {
            stats.other.push(String(chunk.type || '?'))
          }
        }
        if (text.trim()) {
          this.#ok(text, started, picked, tries)
          return { text: text.trim(), elapsedMs: Date.now() - started, model: `${picked.provider}/${picked.model}`, tries }
        }
        lastProblem = lastProblem || (reasoning.trim()
          ? `只输出了思考、没有正文（${reasoning.length} 字思考；这次 maxTokens ${maxTokens}）`
          : `收到 ${stats.chunks} 个块但没有正文（text-delta×${stats.text}、reasoning×${stats.reasoning}、block-end×${stats.blockText}、finish×${stats.finish}${stats.other.length ? `、其它：${stats.other.join('/')}` : ''}）`)
      } catch (error) {
        if (error?.name === 'AbortError') {
          lastProblem = `超时（${Math.round(timeoutMs / 1000)} 秒没等到正文）`
        } else {
          lastProblem = error.message || String(error)
        }
      } finally {
        clearTimeout(timer)
      }
      this.logger.warn(`模型第 ${tries} 次没拿到正文（${attempt.label}）：${clip(lastProblem, 160)}`)
    }

    this.lastError = clip(`模型返回了空内容（试了 ${tries} 次都没正文，最近一次：${lastProblem}）`, 300)
    this.lastCallAt = Date.now()
    this.calls += 1
    throw new Error(this.lastError)
  }

  #ok(text, started, picked, tries) {
    this.lastError = ''
    this.lastCallAt = Date.now()
    this.calls += 1
    this.lastText = clip(text.trim(), 240)
    this.lastModel = `${picked.provider}/${picked.model}`
    this.lastTries = tries
    this.logger.info(`模型回了 ${text.trim().length} 字（${started ? `${Date.now() - started}ms` : ''}，第 ${tries} 次尝试成功）`)
  }
}
