/**
 * 分层相关的宿主接口（prefix 下的 /layered/*）。
 *
 *   POST /layered/decompose   { file, layers, prompt, seed, maxDimension } → { jobId }
 *   GET  /layered/status?job= 进度 / 结果 / 指标
 *   GET  /layered/layer?job=&i=  第 i 层 PNG
 *   GET  /layered/composite?job= 合成后的 PNG
 *   GET  /layered/capabilities  权重是否就位、能不能拆
 *
 * 拆一张 640px 的图在本机要 2–6 分钟，所以是"提交 → 轮询"，不是同步等。
 * 同一时间只跑一个（显存只有 16GB），第二个请求返回 409。
 */

import fs from 'node:fs'
import path from 'node:path'

import { resolveConfig } from './config.js'
import { ComfyClient } from './comfy.js'
import { LAYERED_MODELS, runLayered } from './layered.js'
import { ensureServer, scheduleIdleShutdown } from './server.js'
import { logDebug } from './log.js'
import { decodePng } from './png.js'
import { resize } from './imageops.js'
import { writePsd } from './psd.js'

const jobs = new Map()
let runningId = null

const JOB_TTL_MS = 6 * 60 * 60 * 1000

function pruneJobs() {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (job.state !== 'running' && now - job.startedAt > JOB_TTL_MS) jobs.delete(id)
  }
}

function modelDirs(cfg) {
  const root = cfg.comfy.cwd
  return {
    unet: path.join(root, 'models', 'diffusion_models'),
    clip: path.join(root, 'models', 'text_encoders'),
    vae: path.join(root, 'models', 'vae')
  }
}

/** 权重是否下齐（只查文件在不在，不查完整性和格式）。 */
export function layeredCapabilities(cfg) {
  const dirs = modelDirs(cfg)
  const pick = (dir, name) => {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) return { name, present: false, sizeMb: 0 }
    const size = fs.statSync(file).size
    return { name, present: true, sizeMb: Math.round(size / 1048576) }
  }
  return {
    unet: pick(dirs.unet, LAYERED_MODELS.unetGguf),
    clip: pick(dirs.clip, LAYERED_MODELS.clip),
    vae: pick(dirs.vae, LAYERED_MODELS.vae),
    ggufLoader: fs.existsSync(path.join(cfg.comfy.cwd, 'custom_nodes', 'ComfyUI-GGUF', 'nodes.py'))
  }
}

async function startJob(cfg, options) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const baseDir = cfg.outputDir || path.join(cfg.comfy.cwd, 'gen')
  const dir = path.join(baseDir, 'layers', id)
  const job = {
    id,
    state: 'running',
    startedAt: Date.now(),
    source: options.file,
    layers: options.layers,
    dir,
    metrics: null,
    bounds: null,
    error: null
  }
  jobs.set(id, job)
  runningId = id
  pruneJobs()

  const run = async () => {
    try {
      const server = await ensureServer(cfg, { log: (msg) => logDebug('layered', msg) })
      const client = new ComfyClient(server.baseUrl, { timeoutMs: 60000 })
      const result = await runLayered(client, {
        sourceFile: options.file,
        comfyRoot: cfg.comfy.cwd,
        layers: options.layers,
        prompt: options.prompt,
        seed: options.seed,
        maxDimension: options.maxDimension,
        outDir: dir,
        timeoutMs: options.timeoutMs
      })
      job.state = 'done'
      job.metrics = result.metrics
      job.bounds = result.bounds
      job.compositeFile = result.compositeFile
      job.width = result.composite.width
      job.height = result.composite.height
      job.layerFiles = result.raw
      job.finishedAt = Date.now()
    } catch (error) {
      logDebug('layered job failed', error.message)
      job.state = 'error'
      job.error = error.message
      job.finishedAt = Date.now()
    } finally {
      runningId = null
      scheduleIdleShutdown(cfg, { log: (msg) => logDebug('layered', msg) })
    }
  }
  run()
  return job
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendPng(res, file) {
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  const data = fs.readFileSync(file)
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length, 'Cache-Control': 'no-store' })
  res.end(data)
}

/** 把 src 以左上角 (ox, oy) 叠到 dst 上（source-over，直通 alpha）。 */
function place(dst, src, ox, oy) {
  for (let y = 0; y < src.height; y += 1) {
    const dy = y + oy
    if (dy < 0 || dy >= dst.height) continue
    for (let x = 0; x < src.width; x += 1) {
      const dx = x + ox
      if (dx < 0 || dx >= dst.width) continue
      const si = (y * src.width + x) * 4
      const sa = src.data[si + 3] / 255
      if (sa <= 0) continue
      const di = (dy * dst.width + dx) * 4
      const da = dst.data[di + 3] / 255
      const oa = sa + da * (1 - sa)
      for (let c = 0; c < 3; c += 1) {
        dst.data[di + c] = Math.round((src.data[si + c] * sa + dst.data[di + c] * da * (1 - sa)) / (oa || 1))
      }
      dst.data[di + 3] = Math.round(oa * 255)
    }
  }
}

/**
 * 按前端当前的摆放把图层重新栅格化成 PSD。
 *
 * 前端每个图层是"整幅画布大的图 + 绕中心缩放 scale + 中心平移 (x, y)"，
 * 这里用同样的语义重画一遍，保证 PSD 里看到的和屏幕上一致。
 */
function renderPsd(job, transforms) {
  const width = job.width
  const height = job.height
  const out = []
  for (const item of transforms) {
    const index = Number(item.index)
    const file = job.layerFiles && job.layerFiles[index]
    if (!file || !fs.existsSync(file)) continue
    const base = decodePng(fs.readFileSync(file))
    const scale = Math.min(4, Math.max(0.1, Number(item.scale) || 1))
    const w = Math.max(1, Math.round(base.width * scale))
    const h = Math.max(1, Math.round(base.height * scale))
    const scaled = scale === 1 && w === base.width ? base : resize(base, w, h)
    const canvas = { width, height, data: new Uint8Array(width * height * 4) }
    place(canvas, scaled, Math.round((Number(item.x) || 0) - (w - width) / 2), Math.round((Number(item.y) || 0) - (h - height) / 2))
    out.push({
      name: String(item.name || `图层 ${index + 1}`),
      visible: item.visible !== false,
      image: canvas
    })
  }
  if (!out.length) throw new Error('没有可导出的图层')
  return writePsd({ width, height, layers: out })
}

/**
 * 处理 /layered/* 路由；接了就返回 true，没接返回 false（交给后面的 404）。
 */
export async function handleLayeredRoute(pluginConfig, context) {
  const { req, res, method, route, url, prefix } = context
  if (!route.startsWith('/layered')) return false

  const cfg = resolveConfig(pluginConfig)

  if (method === 'GET' && route === '/layered/capabilities') {
    sendJson(res, 200, { ok: true, ...layeredCapabilities(cfg), running: runningId })
    return true
  }

  if (method === 'POST' && route === '/layered/decompose') {
    const body = await readBody(req)
    const file = path.resolve(String(body.file || ''))
    if (!file || !fs.existsSync(file) || !/\.png$/i.test(file)) {
      sendJson(res, 400, { ok: false, error: '需要一个存在的 PNG 路径（先用画图面板生成一张）' })
      return true
    }
    if (runningId) {
      sendJson(res, 409, { ok: false, error: '已经有一张在拆了，等它跑完', jobId: runningId })
      return true
    }
    const caps = layeredCapabilities(cfg)
    const missing = ['unet', 'clip', 'vae'].filter((k) => !caps[k].present)
    if (missing.length) {
      sendJson(res, 400, {
        ok: false,
        error: `分层权重还没下齐：缺 ${missing.join(' / ')}`,
        capabilities: caps
      })
      return true
    }
    const job = await startJob(cfg, {
      file,
      layers: Math.min(8, Math.max(2, Number(body.layers) || 4)),
      prompt: String(body.prompt || ''),
      seed: Number(body.seed) || 20261106,
      maxDimension: Math.min(1024, Math.max(512, Number(body.maxDimension) || 640)),
      timeoutMs: 20 * 60 * 1000
    })
    sendJson(res, 200, { ok: true, jobId: job.id, file, layers: job.layers })
    return true
  }

  if (method === 'GET' && route === '/layered/status') {
    const job = jobs.get(url.searchParams.get('job') || '')
    if (!job) {
      sendJson(res, 404, { ok: false, error: '没有这个任务（可能已被清理）' })
      return true
    }
    const elapsedMs = (job.finishedAt || Date.now()) - job.startedAt
    sendJson(res, 200, {
      ok: true,
      jobId: job.id,
      state: job.state,
      elapsedMs,
      layers: job.layers,
      metrics: job.metrics,
      bounds: job.bounds,
      error: job.error,
      urls: job.state === 'done'
        ? {
            composite: `${prefix}/layered/composite?job=${job.id}`,
            layerList: Array.from({ length: job.layers }, (_, i) => `${prefix}/layered/layer?job=${job.id}&i=${i}`)
          }
        : undefined
    })
    return true
  }

  if (method === 'GET' && route === '/layered/layer') {
    const job = jobs.get(url.searchParams.get('job') || '')
    const index = Number(url.searchParams.get('i'))
    if (!job || job.state !== 'done') {
      sendJson(res, 404, { ok: false, error: '任务不存在或还没跑完' })
      return true
    }
    if (!Number.isInteger(index) || index < 0 || index >= job.layers) {
      sendJson(res, 400, { ok: false, error: '层号越界' })
      return true
    }
    sendPng(res, path.join(job.dir, `layer-${String(index).padStart(2, '0')}.png`))
    return true
  }

  if (method === 'GET' && route === '/layered/composite') {
    const job = jobs.get(url.searchParams.get('job') || '')
    if (!job || job.state !== 'done') {
      sendJson(res, 404, { ok: false, error: '任务不存在或还没跑完' })
      return true
    }
    sendPng(res, job.compositeFile)
    return true
  }

  if (method === 'POST' && route === '/layered/psd') {
    const body = await readBody(req)
    const job = jobs.get(String(body.job || ''))
    if (!job || job.state !== 'done') {
      sendJson(res, 404, { ok: false, error: '任务不存在或还没跑完' })
      return true
    }
    try {
      const psd = renderPsd(job, Array.isArray(body.layers) ? body.layers : [])
      res.writeHead(200, {
        'Content-Type': 'image/vnd.adobe.photoshop',
        'Content-Length': psd.length,
        'Content-Disposition': `attachment; filename="layered-${job.id}.psd"`,
        'Cache-Control': 'no-store'
      })
      res.end(psd)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message })
    }
    return true
  }

  return false
}
