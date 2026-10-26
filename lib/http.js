import fs from 'node:fs'
import path from 'node:path'
import { clip } from './util.js'

const PREFIX = '/dafeiyu-moderator/api'

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        return resolve(JSON.parse(raw))
      } catch {
        return reject(new Error('请求不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function toNumber(value, fallback = 0) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

export function createHttpHandler({ store, engine, vision, sidecar, logger, login }) {
  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const route = url.pathname.replace(/^\/dafeiyu-moderator\/api/, '') || '/'
    try {
      // ---------------------------------------------------------- GET 只读
      if (req.method === 'GET' && (route === '/status' || route === '/')) {
        return json(res, 200, {
          ok: true,
          status: engine.status(),
          config: store.getConfig(),
          recent: store.recentEvents(40),
          model: engine.brain.describe(),
        })
      }
      if (req.method === 'GET' && route === '/config') {
        return json(res, 200, { ok: true, config: store.getConfig() })
      }
      if (req.method === 'GET' && route === '/events') {
        return json(res, 200, { ok: true, events: store.recentEvents(toNumber(url.searchParams.get('limit'), 100)) })
      }
      if (req.method === 'GET' && route === '/actions') {
        return json(res, 200, { ok: true, actions: store.recentActions(toNumber(url.searchParams.get('limit'), 60)) })
      }
      if (req.method === 'GET' && route === '/ledger') {
        return json(res, 200, { ok: true, users: store.ledgerList(toNumber(url.searchParams.get('limit'), 50)) })
      }
      if (req.method === 'GET' && route === '/snapshot/latest.jpg') {
        const wanted = url.searchParams.get('f')
        let file = null
        if (wanted) {
          const candidate = path.join(store.snapshotDir, path.basename(wanted))
          if (fs.existsSync(candidate) && candidate.startsWith(store.snapshotDir)) file = candidate
        }
        if (!file) file = store.readSnapshotFile()
        if (!file) return json(res, 404, { ok: false, error: '还没有截图，先点一下刷新预览' })
        const buffer = fs.readFileSync(file)
        res.statusCode = 200
        res.setHeader('content-type', 'image/jpeg')
        res.setHeader('cache-control', 'no-store')
        res.setHeader('content-length', buffer.length)
        res.end(buffer)
        return true
      }
      if (req.method === 'GET' && route === '/snapshot') {
        const describe = url.searchParams.get('describe') === '1' || url.searchParams.get('describe') === 'true'
        const looked = await vision.look({ force: true, describe })
        return json(res, 200, {
          ok: true,
          snapshot: { ...looked.snapshot, url: vision.snapshotUrl(looked.snapshot.path) },
          description: looked.scene?.text || '',
          describeError: looked.describeError || '',
        })
      }
      if (req.method === 'GET' && route === '/room') {
        const roomId = toNumber(url.searchParams.get('roomId'), 0) || undefined
        if (!sidecar.running) {
          return json(res, 200, { ok: true, room: engine.status().room, offline: true })
        }
        const data = await sidecar.request('roominfo', roomId ? { roomId } : {}, 25_000)
        return json(res, 200, { ok: true, room: data.room || engine.status().room })
      }
      if (req.method === 'GET' && route === '/scene') {
        return json(res, 200, { ok: true, scene: store.lastScene() })
      }
      if (req.method === 'GET' && route === '/auth/status') {
        return json(res, 200, { ok: true, auth: await login.status() })
      }
      if (req.method === 'GET' && route === '/auth/qr') {
        try {
          return json(res, 200, { ok: true, qr: await login.start() })
        } catch (error) {
          return json(res, 200, { ok: false, error: error?.message || String(error) })
        }
      }
      if (req.method === 'GET' && route === '/auth/poll') {
        const key = url.searchParams.get('key') || ''
        try {
          return json(res, 200, { ok: true, auth: await login.poll(key) })
        } catch (error) {
          return json(res, 200, { ok: false, error: error?.message || String(error) })
        }
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 GET/POST' })
      if (String(req.headers['x-dafeiyu'] || '') !== '1') {
        return json(res, 403, { ok: false, error: '缺少 x-dafeiyu 请求头' })
      }
      const body = await readBody(req)

      // --------------------------------------------------------- POST 动作
      if (route === '/config') {
        const patch = body.patch || body.config || body
        const config = store.patchConfig(patch)
        const wasRunning = engine.started
        if (wasRunning && config.enabled === false) {
          // 只是关掉自动说话/管控，不停止监听
        }
        if (wasRunning && Number(config.roomId) && Number(config.roomId) !== engine.room.roomId) {
          logger.info(`直播间号变了（${engine.room.roomId} → ${config.roomId}），重连`)
          await engine.stop().catch(() => {})
          await engine.start().catch((error) => logger.warn(`按新房间号重连失败：${error.message}`))
        }
        return json(res, 200, { ok: true, config })
      }
      if (route === '/start') {
        const status = await engine.start()
        return json(res, 200, { ok: true, status })
      }
      if (route === '/stop') {
        const status = await engine.stop()
        return json(res, 200, { ok: true, status })
      }
      if (route === '/say') {
        const text = String(body.text || '')
        if (!text.trim()) return json(res, 400, { ok: false, error: '弹幕内容不能为空' })
        const result = await engine.say(text, { replyToUid: toNumber(body.replyTo), reason: '手动发送', kind: 'say', force: true })
        return json(res, result.ok ? 200 : 400, { ok: result.ok, result, error: result.ok ? undefined : result.error })
      }
      if (route === '/warn') {
        const uid = toNumber(body.uid)
        if (!uid) return json(res, 400, { ok: false, error: 'uid 无效' })
        const result = await engine.warn(uid, {
          name: body.name || '',
          reason: body.reason || '手动提醒',
          text: body.text || '',
          category: 'default',
          source: 'manual',
          urgent: true,
        })
        return json(res, result.ok ? 200 : 400, result)
      }
      if (route === '/mute') {
        const uid = toNumber(body.uid)
        if (!uid) return json(res, 400, { ok: false, error: 'uid 无效' })
        const result = await engine.mute(uid, {
          name: body.name || '',
          minutes: toNumber(body.minutes, 5),
          reason: body.reason || '手动禁言',
          text: body.text || '',
          category: 'default',
          source: 'manual',
          urgent: true,
        })
        return json(res, result.ok ? 200 : 400, result)
      }
      if (route === '/unban') {
        const uid = toNumber(body.uid)
        if (!uid) return json(res, 400, { ok: false, error: 'uid 无效' })
        const result = await engine.unban(uid, { announce: body.announce !== false, reason: '手动解禁' })
        return json(res, result.ok ? 200 : 400, result)
      }
      if (route === '/speak') {
        const enabled = body.enabled !== false
        const until = enabled ? 0 : Date.now() + 10 * 60_000
        store.setSpeakPausedUntil(until)
        store.pushAction({ kind: 'system', ok: true, text: enabled ? '恢复机器人说话' : '暂停机器人说话 10 分钟' })
        return json(res, 200, { ok: true, speak: { pausedUntil: until || null } })
      }
      if (route === '/auth/logout') {
        try {
          const auth = await login.logout()
          return json(res, 200, { ok: true, auth })
        } catch (error) {
          return json(res, 400, { ok: false, error: error?.message || String(error) })
        }
      }
      if (route === '/review') {
        const minutes = Math.min(1440, Math.max(5, toNumber(body.minutes, 60)))
        const review = await engine.review(minutes)
        return json(res, 200, { ok: true, review })
      }
      if (route === '/look') {
        const looked = await vision.look({ force: true, describe: body.describe !== false })
        if (body.say === true && looked.scene?.text) {
          await engine.say(looked.scene.text, { reason: '看一眼画面', kind: 'say' }).catch(() => {})
        }
        return json(res, 200, {
          ok: true,
          snapshot: { ...looked.snapshot, url: vision.snapshotUrl(looked.snapshot.path) },
          scene: looked.scene,
          describeError: looked.describeError || '',
        })
      }
      return json(res, 404, { ok: false, error: `未知接口 ${req.method} ${route}` })
    } catch (error) {
      const message = clip(error?.message || String(error), 300)
      logger.warn(`HTTP ${req.method} ${route} 失败：${message}`)
      return json(res, 400, { ok: false, error: message })
    }
  }
  return { path: PREFIX, handler }
}
