import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { clip } from './util.js'

const KNOWN_PYTHONS = [
  path.join(process.env.USERPROFILE || '', '.dsh', 'bili-duty', '.venv', 'Scripts', 'python.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
]

/** 找一个真能跑 bilibili-api 的 Python：优先配置、其次已知 venv、最后 PATH 里的 python。 */
export function resolvePython(configured) {
  if (configured && fs.existsSync(configured)) return configured
  for (const candidate of KNOWN_PYTHONS) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return process.env.DFM_PYTHON || 'python'
}

/**
 * Python 侧车（B 站直播能力）管理器。
 * 负责：拉起子进程、JSONL 请求/回执配对、事件回调、崩溃退避重启。
 */
export class Sidecar {
  constructor({ pythonPath, scriptPath, cwd, logger, onEvent, onLog }) {
    this.pythonPath = pythonPath
    this.scriptPath = scriptPath
    this.cwd = cwd
    this.logger = logger
    this.onEvent = onEvent || (() => {})
    this.onLog = onLog || (() => {})
    this.child = null
    this.reader = null
    this.pending = new Map()
    this.seq = 0
    this.restarts = 0
    this.lastError = ''
    this.startedAt = 0
    this.stopping = false
    this.restartTimer = null
    this.lastStderr = []
  }

  get running() {
    return !!this.child && this.child.exitCode === null && !this.child.killed
  }

  status() {
    return {
      running: this.running,
      pid: this.child ? this.child.pid ?? null : null,
      restarts: this.restarts,
      lastError: this.lastError,
      startedAt: this.startedAt,
    }
  }

  start() {
    if (this.running) return this.status()
    if (!fs.existsSync(this.scriptPath)) {
      this.lastError = `找不到侧车脚本：${this.scriptPath}`
      throw new Error(this.lastError)
    }
    this.stopping = false
    const child = spawn(this.pythonPath, ['-u', this.scriptPath], {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    this.child = child
    this.startedAt = Date.now()
    child.on('error', (error) => {
      this.lastError = `启动 Python 侧车失败：${error.message}`
      this.logger.warn(this.lastError)
      this.onLog({ level: 'error', message: this.lastError })
    })
    child.on('exit', (code, signal) => {
      this.child = null
      this.#failPending(`侧车退出（code=${code}, signal=${signal}）`)
      if (this.stopping) return
      this.lastError = `侧车异常退出（code=${code}），${this.#backoffMs()}ms 后重启`
      this.logger.warn(this.lastError)
      this.restarts += 1
      this.onLog({ level: 'error', message: this.lastError })
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        try {
          this.start()
        } catch (error) {
          this.logger.warn(`重启侧车失败：${error.message}`)
        }
      }, this.#backoffMs())
      if (typeof this.restartTimer.unref === 'function') this.restartTimer.unref()
    })

    const rl = readline.createInterface({ input: child.stdout })
    this.reader = rl
    rl.on('line', (line) => this.#handleLine(line))

    const errRl = readline.createInterface({ input: child.stderr })
    errRl.on('line', (line) => {
      const text = String(line || '').trim()
      if (!text) return
      if (this.lastStderr.length > 40) this.lastStderr.shift()
      this.lastStderr.push(text)
      this.onLog({ level: 'debug', message: clip(text, 300) })
    })
    this.logger.info(`Python 侧车已启动 pid=${child.pid} python=${this.pythonPath}`)
    return this.status()
  }

  #backoffMs() {
    return Math.min(30_000, 1000 * 2 ** Math.min(this.restarts, 5))
  }

  #handleLine(line) {
    const text = String(line || '').trim()
    if (!text) return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      this.onLog({ level: 'debug', message: clip(text, 300) })
      return
    }
    if (message && message.event) {
      try {
        this.onEvent(message)
      } catch (error) {
        this.logger.warn(`处理侧车事件失败：${error.message}`)
      }
      return
    }
    const id = message && message.id
    if (id !== undefined && this.pending.has(id)) {
      const waiter = this.pending.get(id)
      this.pending.delete(id)
      clearTimeout(waiter.timer)
      if (message.ok === false) waiter.reject(new Error(message.error || '侧车返回失败'))
      else waiter.resolve(message.data || {})
    }
  }

  #failPending(reason) {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(reason))
      this.pending.delete(id)
    }
  }

  request(cmd, payload = {}, timeoutMs = 30_000) {
    if (!this.running) {
      return Promise.reject(new Error(`${this.lastError || 'Python 侧车没在运行'}`))
    }
    const id = (this.seq += 1)
    const message = { id, cmd, ...payload }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`侧车命令 ${cmd} 超时（${Math.round(timeoutMs / 1000)} 秒）`))
      }, Math.max(1000, timeoutMs))
      if (typeof timer.unref === 'function') timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8')
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`写给侧车失败：${error.message}`))
      }
    })
  }

  configure(config) {
    return this.request('configure', { config }, 10_000)
  }

  async stop() {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (!child) return
    try {
      await this.request('shutdown', {}, 3000)
    } catch {
      // 关不掉就硬杀
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (child.exitCode === null) {
      try {
        child.stdin.end()
        child.kill()
      } catch {
        // ignore
      }
    }
    this.#failPending('侧车已停止')
    this.child = null
  }
}
