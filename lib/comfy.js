/** ComfyUI HTTP 客户端（只用 Node 内置 fetch，不引任何依赖）。 */

import { ImagePluginError, CODES, looksLikeOom } from './errors.js'

function trimBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '')
}

async function request(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs || 30000)
  const external = options.signal
  const onAbort = () => controller.abort(new Error('aborted'))
  if (external) {
    if (external.aborted) controller.abort(new Error('aborted'))
    else external.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status} ${url} ${text.slice(0, 500)}`)
    }
    return options.asBytes ? Buffer.from(await response.arrayBuffer()) : await response.json()
  } finally {
    clearTimeout(timeout)
    if (external) external.removeEventListener('abort', onAbort)
  }
}

export class ComfyClient {
  constructor(baseUrl, options = {}) {
    this.baseUrl = trimBase(baseUrl)
    this.timeoutMs = options.timeoutMs || 30000
  }

  withBase(baseUrl) {
    return new ComfyClient(baseUrl, { timeoutMs: this.timeoutMs })
  }

  /** 探活：连通且是 ComfyUI 才返回系统信息，否则 null（不抛错）。 */
  async health(timeoutMs = 2500) {
    try {
      const stats = await request(`${this.baseUrl}/system_stats`, { timeoutMs })
      if (stats && (stats.system || stats.devices)) return stats
      return null
    } catch {
      return null
    }
  }

  getJson(pathname, timeoutMs = this.timeoutMs) {
    return request(`${this.baseUrl}${pathname}`, { timeoutMs })
  }

  postJson(pathname, body, timeoutMs = this.timeoutMs) {
    return request(`${this.baseUrl}${pathname}`, { method: 'POST', body, timeoutMs })
  }

  getBytes(pathname, timeoutMs = 120000) {
    return request(`${this.baseUrl}${pathname}`, { timeoutMs, asBytes: true })
  }

  objectInfo(nodeClass) {
    return this.getJson(`/object_info/${nodeClass}`, 15000)
  }

  async submit(workflow) {
    let result
    try {
      result = await this.postJson('/prompt', { prompt: workflow, client_id: `dsh-qwen-image-${Date.now()}` }, 60000)
    } catch (error) {
      throw new ImagePluginError(
        CODES.SUBMIT_FAILED,
        `提交工作流失败：${error.message}`,
        '确认 ComfyUI 版本 ≥ 0.37.0 且三个 Qwen 节点存在；用 doctor 自检'
      )
    }
    if (!result || !result.prompt_id) {
      const detail = JSON.stringify(result && (result.error || result)).slice(0, 1200)
      if (looksLikeOom(detail)) {
        throw new ImagePluginError(CODES.OOM, `显存不足：${detail}`, '换 fast 档或改 1024² 再试')
      }
      if (/cannot find|not found|no such node|invalid node/i.test(detail)) {
        throw new ImagePluginError(
          CODES.MISSING_NODE,
          `工作流里有节点不被 ComfyUI 识别：${detail}`,
          'ComfyUI 需要 ≥ 0.37.0（本机 0.40.0 已满足）；若刚升级请重启 ComfyUI'
        )
      }
      throw new ImagePluginError(CODES.SUBMIT_FAILED, `ComfyUI 拒绝了这个工作流：${detail}`, '用 doctor 检查节点与模型列表')
    }
    return result.prompt_id
  }

  async history(promptId) {
    const history = await this.getJson(`/history/${promptId}`, 30000)
    return history ? history[promptId] : undefined
  }

  /**
   * 轮询直到出图 / 报错 / 超时 / 被取消。
   * @returns {{entry: object, images: object[]}}
   */
  async waitFor(promptId, options = {}) {
    const timeoutMs = options.timeoutMs || 900000
    const interval = options.intervalMs || 1200
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (options.signal && options.signal.aborted) {
        await this.interrupt().catch(() => {})
        throw new ImagePluginError(CODES.ABORTED, '生成被取消', '如需重试重新调用一次即可')
      }
      const entry = await this.history(promptId).catch(() => undefined)
      if (entry) {
        const status = entry.status || {}
        if (status.status_str === 'error') {
          const detail = JSON.stringify(status).slice(0, 2000)
          if (looksLikeOom(detail)) {
            throw new ImagePluginError(
              CODES.OOM,
              `显存不足（OOM）：${detail}`,
              '换 fast 档、或把尺寸降到 1024²、或关闭其它占用显存的程序后重试'
            )
          }
          throw new ImagePluginError(CODES.EXECUTION_FAILED, `ComfyUI 执行出错：${detail}`, '看 ComfyUI 窗口日志里的第一个报错')
        }
        const images = []
        for (const output of Object.values(entry.outputs || {})) {
          for (const image of output.images || []) images.push(image)
        }
        if (images.length) return { entry, images }
        if (status.completed === true) {
          throw new ImagePluginError(CODES.NO_IMAGE, 'ComfyUI 执行完成但没有产出图片', '检查工作流是否连到了 SaveImage/PreviewImage')
        }
      }
      if (options.onTick) options.onTick(Date.now())
      await new Promise((resolve) => setTimeout(resolve, interval))
    }
    await this.interrupt().catch(() => {})
    throw new ImagePluginError(
      CODES.TIMEOUT,
      `生成超时（${Math.round(timeoutMs / 1000)} 秒）`,
      '首张图需要把权重搬进显存，可加大 timeout_ms；或换 fast 档先验证链路'
    )
  }

  async download(imageRef, filePath) {
    const query = new URLSearchParams({
      filename: imageRef.filename,
      subfolder: imageRef.subfolder || '',
      type: imageRef.type || 'output'
    })
    const bytes = await this.getBytes(`/view?${query.toString()}`)
    const fs = await import('node:fs')
    const path = await import('node:path')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, bytes)
    return { file: filePath, bytes: bytes.length }
  }

  async interrupt() {
    return this.postJson('/interrupt', {}, 10000)
  }

  /** ComfyUI 的 /free：让它在空闲时卸载权重，避免占着 13 GB 显存。 */
  async free(options = {}) {
    return this.postJson(
      '/free',
      { unload_models: options.unloadModels !== false, free_memory: options.freeMemory !== false },
      10000
    )
  }
}

export function systemSummary(stats) {
  const system = (stats && stats.system) || {}
  const device = ((stats && stats.devices) || [{}])[0] || {}
  return {
    comfyuiVersion: system.comfyui_version || '?',
    pythonVersion: system.python_version || '?',
    torchVersion: device.torch_version || '?',
    vramTotalMb: Math.round((device.vram_total || 0) / 1048576),
    vramFreeMb: Math.round((device.vram_free || 0) / 1048576),
    deviceName: device.name || '?'
  }
}
