/**
 * ComfyUI 进程生命周期：探活 → 选端口 → 拉起 → 等就绪 → 空闲自动关。
 *
 * 端口策略（回答“开端口要不要人管”）：
 *   1. 按 portCandidates 顺序尝试，8188 是 ComfyUI 官方默认，撞车概率最低；
 *   2. 端口上已经有 ComfyUI → 直接复用（不重复起进程）；
 *   3. 端口被别的程序占用 → 跳过，试下一个；全被占才报错并给出改配置的位置；
 *   4. 最终端口写入 runtime.json，DSH 重启后仍然复用同一个实例。
 */

import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

import { ComfyClient } from './comfy.js'
import { ImagePluginError, CODES } from './errors.js'
import { clearRuntime, ensureDir, LOG_DIR, readRuntime, writeRuntime } from './config.js'
import { timestamp } from './files.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let owned = null
let idleTimer = null
let starting = null

export function isOwnedRunning() {
  return Boolean(owned && owned.child && owned.child.exitCode === null && !owned.error)
}

export function ownedInfo() {
  if (!owned) return null
  return { port: owned.port, pid: owned.child.pid, baseUrl: owned.baseUrl, startedAt: owned.startedAt, logPath: owned.logPath }
}

export function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

export function portUrl(port) {
  return `http://127.0.0.1:${port}`
}

export async function healthAt(baseUrl, timeoutMs = 2500) {
  if (!baseUrl) return null
  return new ComfyClient(baseUrl, { timeoutMs }).health(timeoutMs)
}

/** 端口是否空闲（能 bind 就说明没有别的进程监听）。 */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    try {
      server.listen(port, '127.0.0.1')
    } catch {
      resolve(false)
    }
  })
}

function tailLog(logPath, lines = 30) {
  try {
    const text = fs.readFileSync(logPath, 'utf8').trim()
    return text.split(/\r?\n/).slice(-lines).join('\n')
  } catch {
    return ''
  }
}

function startProcess(config, port) {
  ensureDir(LOG_DIR)
  const logPath = path.join(LOG_DIR, `comfyui-${timestamp()}.log`)
  const fd = fs.openSync(logPath, 'a')
  const args = [
    config.comfy.main,
    '--port',
    String(port),
    '--listen',
    config.comfy.listenHost || '127.0.0.1',
    ...(config.comfy.args || [])
  ]
  const child = spawn(config.comfy.python, args, {
    cwd: config.comfy.cwd,
    stdio: ['ignore', fd, fd],
    windowsHide: true
  })
  const ref = {
    child,
    port,
    logPath,
    baseUrl: portUrl(port),
    startedAt: Date.now(),
    error: null
  }
  child.once('error', (error) => {
    ref.error = error
  })
  child.once('exit', () => {
    if (owned && owned.child === child) owned = null
  })
  return ref
}

function stopProcess(ref) {
  if (!ref || !ref.child) return
  const pid = ref.child.pid
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      ref.child.kill('SIGTERM')
    }
  } catch {
    /* 忽略：关不掉也不该影响出图结果 */
  }
}

async function waitReady(ref, timeoutMs) {
  const client = new ComfyClient(ref.baseUrl, { timeoutMs: 3000 })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ref.error) return null
    if (ref.child.exitCode !== null) return null
    const stats = await client.health(3000)
    if (stats) return stats
    await sleep(1200)
  }
  return null
}

function startFailure(ref, config) {
  const tail = tailLog(ref.logPath)
  const reason = ref.error ? `进程无法启动：${ref.error.message}` : '进程启动后未能就绪'
  return new ImagePluginError(
    CODES.SERVER_START_FAILED,
    `无法拉起 ComfyUI（${reason}，端口 ${ref.port}）\n日志：${ref.logPath}\n${tail}`,
    '检查配置 ~/.dsh-qwen-image/config.json 里的 comfy.python / comfy.main 路径；或手动双击插件目录里的 start-server.cmd'
  )
}

async function pickAndStart(config, log) {
  const hintPort = (() => {
    if (!config.baseUrl) return null
    try {
      const url = new URL(config.baseUrl)
      return Number(url.port || 80)
    } catch {
      return null
    }
  })()
  const candidates = hintPort
    ? [hintPort, ...config.comfy.portCandidates.filter((port) => port !== hintPort)]
    : config.comfy.portCandidates

  for (const port of candidates) {
    const url = portUrl(port)
    const existing = await healthAt(url)
    if (existing) {
      log(`端口 ${port} 上已有 ComfyUI，直接复用`)
      writeRuntime(config, { port, baseUrl: url, startedByUs: false, adopted: true })
      return { baseUrl: url, startedByUs: false, stats: existing }
    }
    const free = await isPortFree(port)
    if (!free) {
      log(`端口 ${port} 被其它程序占用，顺延`)
      continue
    }
    log(`在端口 ${port} 上拉起 ComfyUI：${config.comfy.python} ${config.comfy.main}`)
    const ref = startProcess(config, port)
    const stats = await waitReady(ref, config.comfy.startTimeoutMs)
    if (!stats) {
      stopProcess(ref)
      throw startFailure(ref, config)
    }
    owned = ref
    writeRuntime(config, {
      port,
      pid: ref.child.pid,
      baseUrl: ref.baseUrl,
      startedByUs: true,
      logPath: ref.logPath
    })
    log(`ComfyUI 就绪：${ref.baseUrl}（pid=${ref.child.pid}，日志 ${ref.logPath}）`)
    return { baseUrl: ref.baseUrl, startedByUs: true, stats }
  }

  throw new ImagePluginError(
    CODES.SERVER_START_FAILED,
    `端口候选全部不可用：${candidates.join(', ')}`,
    '在 ~/.dsh-qwen-image/config.json 里改 comfy.portCandidates（加一个空闲端口即可）'
  )
}

/**
 * 保证有一个可用的 ComfyUI。
 * @returns {Promise<{baseUrl: string, startedByUs: boolean, stats: object}>}
 */
export async function ensureServer(config, options = {}) {
  const log = options.log || (() => {})
  // 新任务开始时取消上一次的空闲关机计时；否则上一次留下的 15 分钟计时器
  // 可能在新任务采样到一半时把 ComfyUI 关掉。
  clearIdleTimer()

  // 1) 显式配置了 baseUrl 且能连上 → 直接用
  if (config.baseUrl) {
    const stats = await healthAt(config.baseUrl)
    if (stats) return { baseUrl: config.baseUrl, startedByUs: false, stats }
    if (config.comfy.mode !== 'auto') {
      throw new ImagePluginError(
        CODES.SERVER_DOWN,
        `连不上 ${config.baseUrl}（comfy.mode=${config.comfy.mode}，不会帮你启动）`,
        '启动 ComfyUI，或把 comfy.mode 改成 auto 让插件代劳'
      )
    }
  }

  if (config.comfy.mode === 'off' || config.comfy.mode === 'external') {
    throw new ImagePluginError(
      CODES.SERVER_DOWN,
      'ComfyUI 未运行，且配置为不自动启动（comfy.mode=' + config.comfy.mode + '）',
      '手动启动（插件目录 start-server.cmd），或把 comfy.mode 改成 auto'
    )
  }

  // 2) 复用上一次运行留下的实例
  const runtime = readRuntime(config)
  if (runtime && runtime.port) {
    const stats = await healthAt(portUrl(runtime.port))
    if (stats) return { baseUrl: portUrl(runtime.port), startedByUs: false, stats }
    clearRuntime(config)
  }

  // 3) 当前进程自己起过且在跑
  if (isOwnedRunning()) {
    const stats = await healthAt(owned.baseUrl)
    if (stats) return { baseUrl: owned.baseUrl, startedByUs: true, stats }
  }

  // 4) 并发调用只启动一次
  if (starting) return starting
  starting = (async () => {
    try {
      return await pickAndStart(config, log)
    } finally {
      starting = null
    }
  })()
  return starting
}

/** 空闲自动关：释放约 13 GB 内存；只在“是自己起的”时候生效。 */
export function scheduleIdleShutdown(config, options = {}) {
  clearIdleTimer()
  const idleMs = config.comfy.idleShutdownMs
  if (!idleMs || !isOwnedRunning()) return
  const client = new ComfyClient(owned.baseUrl)
  const log = options.log || (() => {})
  idleTimer = setTimeout(async () => {
    idleTimer = null
    const ref = owned
    if (!ref) return
    try {
      if (config.comfy.unloadBeforeShutdown) await client.free({ unloadModels: true, freeMemory: true })
    } catch {
      /* 忽略 */
    }
    stopProcess(ref)
    owned = null
    clearRuntime(config)
    log(`空闲 ${Math.round(idleMs / 1000)} 秒，已关闭自己拉起的 ComfyUI（释放内存）`)
  }, idleMs)
  if (idleTimer.unref) idleTimer.unref()
}

/** 立即关掉自己起的实例（doctor / 卸载时用）。 */
export async function shutdownOwnedServer(config, options = {}) {
  clearIdleTimer()
  if (!isOwnedRunning()) return false
  const ref = owned
  const client = new ComfyClient(ref.baseUrl)
  try {
    if (!options.skipFree) await client.free({ unloadModels: true, freeMemory: true })
  } catch {
    /* 忽略 */
  }
  stopProcess(ref)
  owned = null
  if (config) clearRuntime(config)
  return true
}
