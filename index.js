// 大肥鱼 · AI 房管（B 站直播间）
// 看弹幕、看画面、像真人一样参与，会 @ 提醒，屡教不改才短禁言。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './lib/store.js'
import { resolvePython, Sidecar } from './lib/py.js'
import { Brain } from './lib/llm.js'
import { Vision } from './lib/vision.js'
import { Engine } from './lib/engine.js'
import { createHttpHandler } from './lib/http.js'
import { createLogin } from './lib/login.js'
import { registerTools } from './lib/tools.js'

export const inject = ['tools', 'webServer', 'llm', 'agentDefaultModel']

const ROOT = path.dirname(fileURLToPath(import.meta.url))

export function apply(ctx) {
  const logger = ctx.logger
  const store = new Store(ROOT)
  let engine = null

  const sidecar = new Sidecar({
    pythonPath: resolvePython(store.getConfig().pythonPath),
    scriptPath: path.join(ROOT, 'python', 'moderator.py'),
    cwd: ROOT,
    logger,
    onEvent: (event) => {
      if (!engine) return
      engine.handleEvent(event).catch((error) => logger.warn(`处理侧车事件失败：${error.message}`))
    },
    onLog: (line) => {
      if (line.level === 'error') logger.warn(`[侧车] ${line.message}`)
    },
  })

  const brain = new Brain({ ctx, logger, store })
  const vision = new Vision({
    sidecar,
    store,
    brain,
    logger,
    getConfig: () => store.getConfig(),
  })

  engine = new Engine({ ctx, store, sidecar, brain, vision, logger })
  const login = createLogin({ sidecar, store, engine, logger })

  // 配置变了就换 Python 解释器（下次启动生效）
  ctx.effect(() => {
    const update = () => {
      const wanted = resolvePython(store.getConfig().pythonPath)
      if (wanted !== sidecar.pythonPath) {
        sidecar.pythonPath = wanted
        logger.info(`Python 解释器换成 ${wanted}`)
      }
    }
    const timer = setInterval(update, 30_000)
    if (typeof timer.unref === 'function') timer.unref()
    update()
    return () => clearInterval(timer)
  }, 'dafeiyu-moderator: python watch')

  registerTools(ctx, { engine, store, vision, sidecar, login })

  const http = createHttpHandler({ store, engine, vision, sidecar, logger, login })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: http.path, handler: http.handler }), 'dafeiyu-moderator: http')

  const config = store.getConfig()
  if (config.enabled && Number(config.roomId)) {
    const timer = setTimeout(() => {
      engine.start().catch((error) => logger.warn(`自动开工失败：${error.message}`))
    }, 4000)
    if (typeof timer.unref === 'function') timer.unref()
  }

  ctx.effect(
    () => () => {
      engine.shutdown().catch(() => {})
    },
    'dafeiyu-moderator: dispose',
  )

  logger.info(`大肥鱼 AI 房管已加载：面板在「设置 → AI 房管」，接口 /dafeiyu-moderator/api`)
}
