/**
 * 宿主侧 HTTP 接口（仅 Web 宿主有 webServer 时注册）：
 *   GET  {prefix}/state          运行状态 + 选中模型
 *   POST {prefix}/start          确保 ComfyUI 在跑（必要时自动拉起）
 *   POST {prefix}/open           确保在跑，并用系统默认浏览器打开前端
 *   GET  {prefix}/models         本地模型清单
 *   POST {prefix}/models/search  关键词搜索仓库
 *   POST {prefix}/models/files   列仓库文件
 *   POST {prefix}/models/download 下载文件
 *   POST {prefix}/models/select  切换选中模型
 *   POST {prefix}/models/delete  删除本地模型
 *   POST {prefix}/generate       生成一张图（面板用）
 *   GET  {prefix}/image?name=    取回生成的图片
 *
 * 设置页 / 画图面板（lib/client.js）就是用这些接口做按钮。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { resolveConfig } from './config.js'
import { ComfyClient, systemSummary } from './comfy.js'
import { ensureServer, healthAt, scheduleIdleShutdown } from './server.js'
import { deleteModel, downloadModel, listLocalModels, listRepoFiles, searchRemoteModels, selectModel } from './models.js'
import { runGeneration } from './runner.js'
import { runVariants } from './batch.js'
import { renderFailureText } from './result.js'
import { handleLayeredRoute } from './layered-api.js'
import { logDebug } from './log.js'

const MAX_BODY_BYTES = 2 * 1024 * 1024

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** 在宿主操作系统上用默认浏览器打开 URL（Windows / macOS / Linux）。 */
export function openInDefaultBrowser(url) {
  try {
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '""', url], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      })
      child.unref()
      return true
    }
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(command, [url], { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch (error) {
    logDebug('openInDefaultBrowser failed', error.message)
    return false
  }
}

async function currentState(config) {
  const local = listLocalModels(config)
  let running = false
  let baseUrl = config.baseUrl || ''
  let summary = null
  if (baseUrl) {
    const stats = await healthAt(baseUrl)
    if (stats) {
      running = true
      summary = systemSummary(stats)
    }
  }
  if (!running) {
    for (const port of config.comfy.portCandidates) {
      const candidate = `http://127.0.0.1:${port}`
      const stats = await healthAt(candidate)
      if (stats) {
        running = true
        baseUrl = candidate
        summary = systemSummary(stats)
        break
      }
    }
  }
  return {
    running,
    baseUrl: baseUrl || `http://127.0.0.1:${config.comfy.portCandidates[0]}`,
    comfy: summary,
    models: local.items,
    selected: local.selected,
    modelsRoot: local.root,
    config: {
      comfyMode: config.comfy.mode,
      idleShutdownMs: config.comfy.idleShutdownMs,
      toolName: config.toolName,
      modelsToolName: config.modelsToolName
    }
  }
}

/**
 * 注册 HTTP 路由。返回 disposer（cordis effect 里用）。
 * @param {object} ctx 宿主上下文（需有 webServer）
 * @param {unknown} pluginConfig
 */
export function registerApi(ctx, pluginConfig) {
  const config = resolveConfig(pluginConfig)
  const prefix = config.apiPath

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const route = url.pathname.slice(prefix.length).replace(/\/+$/, '') || '/'
    const method = (req.method || 'GET').toUpperCase()
    try {
      if (method === 'GET' && (route === '/' || route === '/state')) {
        return sendJson(res, 200, await currentState(resolveConfig(pluginConfig)))
      }

      if (method === 'POST' && route === '/start') {
        const cfg = resolveConfig(pluginConfig)
        const server = await ensureServer(cfg, { log: (msg) => logDebug('api', msg) })
        scheduleIdleShutdown(cfg, { log: (msg) => logDebug('api', msg) })
        const stats = server.stats || (await new ComfyClient(server.baseUrl).health())
        return sendJson(res, 200, {
          ok: true,
          running: true,
          baseUrl: server.baseUrl,
          startedByUs: server.startedByUs,
          comfy: stats ? systemSummary(stats) : null
        })
      }

      if (method === 'POST' && route === '/open') {
        const cfg = resolveConfig(pluginConfig)
        const server = await ensureServer(cfg, { log: (msg) => logDebug('api', msg) })
        scheduleIdleShutdown(cfg, { log: (msg) => logDebug('api', msg) })
        const target = `${server.baseUrl}/`
        const opened = cfg.comfy.openInBrowser === false ? false : openInDefaultBrowser(target)
        return sendJson(res, 200, { ok: true, url: target, opened, startedByUs: server.startedByUs })
      }

      if (method === 'GET' && route === '/models') {
        return sendJson(res, 200, { ok: true, ...listLocalModels(resolveConfig(pluginConfig)) })
      }

      if (method === 'POST' && route === '/models/search') {
        const body = await readJsonBody(req)
        const result = await searchRemoteModels(resolveConfig(pluginConfig), body.keyword, {
          provider: body.provider,
          limit: body.limit
        })
        return sendJson(res, 200, { ok: true, ...result })
      }

      if (method === 'POST' && route === '/models/files') {
        const body = await readJsonBody(req)
        const result = await listRepoFiles(resolveConfig(pluginConfig), body)
        return sendJson(res, 200, { ok: true, ...result })
      }

      if (method === 'POST' && route === '/models/download') {
        const body = await readJsonBody(req)
        const result = await downloadModel(resolveConfig(pluginConfig), body)
        return sendJson(res, 200, { ok: true, ...result })
      }

      if (method === 'POST' && route === '/models/select') {
        const body = await readJsonBody(req)
        const result = selectModel(resolveConfig(pluginConfig), body.role, body.name)
        return sendJson(res, 200, { ok: true, ...result })
      }

      if (method === 'POST' && route === '/models/delete') {
        const body = await readJsonBody(req)
        const result = deleteModel(resolveConfig(pluginConfig), body.role, body.name)
        return sendJson(res, 200, { ok: true, ...result })
      }

      // 画图面板：多方案批量生成（每行一个方案）
      if (method === 'POST' && route === '/generate-batch') {
        const body = await readJsonBody(req)
        const cfg = resolveConfig(pluginConfig)
        const run = await runVariants({
          variants: body.variants || [],
          cwd: cfg.outputDir || cfg.comfy.cwd,
          config: cfg,
          log: (msg) => logDebug('api', msg)
        })
        const results = run.results.map((item) => ({
          index: item.index,
          label: item.label,
          name: path.basename(item.file),
          url: `${prefix}/image?name=${encodeURIComponent(path.basename(item.file))}`,
          seed: item.seed,
          width: item.width,
          height: item.height,
          durationMs: item.durationMs,
          gate: item.gate
        }))
        return sendJson(res, 200, { ok: true, totalMs: run.totalMs, results })
      }

      // 画图面板：生成一张图，返回可直接 <img> 的地址
      if (method === 'POST' && route === '/generate') {
        const body = await readJsonBody(req)
        const cfg = resolveConfig(pluginConfig)
        const run = await runGeneration({
          args: {
            prompt: body.prompt,
            preset: body.preset,
            aspect_ratio: body.aspect_ratio,
            width: body.width,
            height: body.height,
            steps: body.steps,
            seed: body.seed,
            transparent: body.transparent,
            output_path: body.output_path
          },
          cwd: cfg.outputDir || cfg.comfy.cwd,
          config: cfg,
          log: (msg) => logDebug('api', msg)
        })
        const name = path.basename(run.file)
        return sendJson(res, 200, {
          ok: true,
          name,
          url: `${prefix}/image?name=${encodeURIComponent(name)}`,
          file: run.file,
          seed: run.request.seed,
          preset: run.request.preset.name,
          width: run.request.width,
          height: run.request.height,
          steps: run.request.steps,
          durationMs: run.timing.totalMs,
          gate: run.gate.passed === true,
          sidecar: run.sidecar
        })
      }

      // 画图面板：按文件名取回生成的图片（只允许 outputDir 内的 png）
      if (method === 'GET' && route === '/image') {
        const cfg = resolveConfig(pluginConfig)
        const dir = cfg.outputDir || path.join(cfg.comfy.cwd, 'gen')
        const name = path.basename(url.searchParams.get('name') || '')
        if (!name || !/\.(png|webp)$/i.test(name)) {
          return sendJson(res, 400, { ok: false, error: '缺少合法的图片名' })
        }
        const file = path.resolve(dir, name)
        if (!file.startsWith(path.resolve(dir) + path.sep)) {
          return sendJson(res, 400, { ok: false, error: '路径越界' })
        }
        if (!fs.existsSync(file)) {
          return sendJson(res, 404, { ok: false, error: '图片不存在（可能已被清理）' })
        }
        const data = fs.readFileSync(file)
        res.writeHead(200, {
          'Content-Type': name.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/png',
          'Content-Length': data.length,
          'Cache-Control': 'no-store'
        })
        res.end(data)
        return
      }

      if (route.startsWith('/layered')) {
        const handled = await handleLayeredRoute(pluginConfig, { req, res, method, route, url, prefix })
        if (handled) return
      }

      return sendJson(res, 404, { ok: false, error: `未知接口 ${method} ${route}` })
    } catch (error) {
      logDebug('api error', error.message)
      return sendJson(res, 500, { ok: false, error: renderFailureText(error) })
    }
  }

  return ctx.webServer.register({ kind: 'prefix', path: prefix, handler })
}
