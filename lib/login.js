// B 站扫码登录：侧车拿 qrcode_key、跑轮询、把 Set-Cookie 里的凭证写进本机文件。
// 二维码在服务端画成 SVG（不把登录 URL 交给第三方），浏览器只显示图片。
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)

let QR = null
try {
  QR = require(join(ROOT, 'vendor', 'node_modules', 'qrcode', 'lib', 'browser.js'))
} catch {
  QR = null
}

export function createLogin({ sidecar, store, engine, logger }) {
  async function status() {
    try {
      const data = await sidecar.request('auth_status', {}, 20_000)
      return { ...(data?.auth || {}), sidecar: 'ok' }
    } catch (error) {
      return {
        loggedIn: false,
        exists: false,
        file: store.credentialPath(),
        message: `侧车没连上：${error?.message || error}`,
        sidecar: 'down',
      }
    }
  }

  async function start() {
    const data = await sidecar.request('auth_qr', {}, 25_000)
    const item = data?.qr || {}
    if (!item.url) throw new Error('侧车没返回登录二维码地址')
    let svg = ''
    if (QR) {
      svg = await QR.toString(item.url, { type: 'svg', margin: 1, width: 260, errorCorrectionLevel: 'M' })
    }
    store.pushAction({ kind: 'login', ok: true, reason: '生成登录二维码' })
    return {
      key: item.key,
      svg,
      expiresIn: Number(item.expiresIn) || 180,
      note: svg ? '' : '二维码渲染组件缺失（vendor/node_modules/qrcode），可把下面的登录地址复制到手机浏览器打开',
      url: item.url,
    }
  }

  async function poll(key) {
    const data = await sidecar.request('auth_poll', { key }, 25_000)
    const auth = data?.auth || {}
    if (auth.state === 'ok') {
      const name = auth.user?.uname || '已登录'
      logger?.info?.(`B 站登录成功：${name}`)
      store.pushAction({ kind: 'login', ok: true, reason: `扫码登录成功：${name}` })
      if (engine?.started) {
        engine.reconnectAfterLogin().catch((error) => {
          logger?.warn?.(`登录后重连失败：${error?.message || error}`)
        })
      }
    }
    return auth
  }

  async function logout() {
    const data = await sidecar.request('auth_logout', {}, 20_000)
    store.pushAction({ kind: 'login', ok: true, reason: '退出登录（本机凭证已删除）' })
    return data?.auth || { ok: true }
  }

  return { status, start, poll, logout }
}
