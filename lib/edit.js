/**
 * 图生图 / 局部修改（img2img / inpaint）。
 *
 * 和 generate_image 的区别：这里必须有一张输入图。给了 mask 就只改 mask 里，
 * 不给 mask 就按 denoise 强度整图重画（0.3~0.6 通常是“换风格但保留构图”）。
 *
 * ComfyUI 侧用 Qwen-Image-2.1 的同一套三件套模型；mask 走
 * LoadImage → ImageScale → ImageToMask → SetLatentNoiseMask，
 * 这样 mask 外的 latent 不会被采样器改写。输出仍走 PreviewImage，不污染 output。
 */

import fs from 'node:fs'
import path from 'node:path'

import { ComfyClient } from './comfy.js'
import { ensureServer, scheduleIdleShutdown } from './server.js'
import { assertComfyReady } from './runner.js'
import { presetFor } from './presets.js'
import { decodePng, encodePng } from './png.js'
import { resize } from './imageops.js'
import { gateImage, summarizeGate } from './gate.js'
import { planOutput, timestamp, writeSidecar, toFileUrl } from './files.js'
import { ImagePluginError, CODES } from './errors.js'
import { resolveConfig, expandHome } from './config.js'

/** mask 外像素允许的平均变化（VAE 重编码会有 1~2 的误差）。 */
export const MASK_OUTSIDE_TOLERANCE = 8

function readPng(filePath, role) {
  let buffer
  try {
    buffer = fs.readFileSync(filePath)
  } catch (error) {
    throw new ImagePluginError(
      CODES.BAD_ARGS,
      `读不到${role}：${filePath}`,
      '检查路径是否存在；相对路径按会话工作目录解析'
    )
  }
  try {
    const image = decodePng(buffer)
    return { ...image, file: filePath, bytes: buffer.length }
  } catch (error) {
    throw new ImagePluginError(
      CODES.BAD_ARGS,
      `${role}不是可解码的 PNG：${filePath}`,
      '输入图和遮罩都请用 PNG（RGBA/RGB 都行）；JPG/WebP 请先转成 PNG'
    )
  }
}

/** 把一个文件复制进 ComfyUI 的 input 根目录；名字带时间戳和随机后缀，避免互相覆盖。 */
function stageFile(comfyRoot, sourceFile, prefix) {
  const dir = path.join(comfyRoot, 'input')
  fs.mkdirSync(dir, { recursive: true })
  const ext = path.extname(sourceFile) || '.png'
  const base = path.basename(sourceFile, ext).replace(/[^\w.-]/g, '_').slice(0, 40)
  const name = `ksedit-${prefix}-${timestamp()}-${Math.random().toString(36).slice(2, 6)}-${base}${ext}`
  fs.copyFileSync(sourceFile, path.join(dir, name))
  return name
}

/** 把输入收进 maxSide 内，并对齐到 16 的倍数（latent 步长 8）。 */
export function fitEditSize(width, height, maxSide = 1024) {
  const scale = Math.min(1, maxSide / Math.max(width, height))
  const snap = (value) => Math.max(16, Math.round((value * scale) / 16) * 16)
  return { width: snap(width), height: snap(height) }
}

export function buildEditWorkflow(options) {
  const {
    request,
    models,
    imageName,
    maskName = '',
    prefix = 'dsh-qwen-edit'
  } = options
  const useMask = Boolean(maskName)
  const { width, height, denoise, steps, cfgScale, seed, sampler, scheduler, finalPrompt, negativePrompt } = request
  const unetFile = models[request.preset.unet]
  const clipFile = models[request.preset.clip]
  const vaeFile = models.vae
  for (const [role, value] of Object.entries({ unet: unetFile, clip: clipFile, vae: vaeFile })) {
    if (!value) throw new Error(`配置里缺少 models.${role}（当前档位 ${request.preset.name} 需要它）`)
  }

  const workflow = {
    1: { class_type: 'LoadImage', inputs: { image: imageName }, _meta: { title: '输入图' } },
    3: {
      class_type: 'ImageScale',
      inputs: { image: ['1', 0], upscale_method: 'lanczos', width, height, crop: 'disabled' },
      _meta: { title: `输入图缩放 ${width}x${height}` }
    },
    6: { class_type: 'VAEEncode', inputs: { pixels: ['3', 0], vae: ['8', 0] }, _meta: { title: '编码输入图' } },
    8: { class_type: 'VAELoader', inputs: { vae_name: vaeFile } },
    9: { class_type: 'UNETLoader', inputs: { unet_name: unetFile, weight_dtype: 'default' } },
    10: { class_type: 'CLIPLoader', inputs: { clip_name: clipFile, type: 'qwen_image', device: 'default' } },
    11: {
      class_type: 'TextEncodeQwenImage21',
      inputs: {
        clip: ['10', 0],
        prompt: finalPrompt,
        negative_prompt: negativePrompt,
        resolution: 1024
      },
      _meta: { title: '修改指令' }
    }
  }

  let latentRef = ['6', 0]
  if (useMask) {
    workflow[2] = { class_type: 'LoadImage', inputs: { image: maskName }, _meta: { title: '遮罩' } }
    workflow[4] = {
      class_type: 'ImageScale',
      inputs: { image: ['2', 0], upscale_method: 'nearest-exact', width, height, crop: 'disabled' },
      _meta: { title: '遮罩缩放' }
    }
    workflow[5] = {
      class_type: 'ImageToMask',
      inputs: { image: ['4', 0], channel: 'red' },
      _meta: { title: '遮罩转 mask' }
    }
    workflow[7] = {
      class_type: 'SetLatentNoiseMask',
      inputs: { samples: ['6', 0], mask: ['5', 0] },
      _meta: { title: '只改遮罩区域' }
    }
    latentRef = ['7', 0]
  }

  workflow[12] = {
    class_type: 'KSampler',
    inputs: {
      seed,
      steps,
      cfg: cfgScale,
      sampler_name: sampler,
      scheduler,
      denoise,
      model: ['9', 0],
      positive: ['11', 0],
      negative: ['11', 1],
      latent_image: latentRef
    },
    _meta: { title: `KSampler ${steps} 步 / denoise ${denoise}` }
  }
  workflow[13] = { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['8', 0] } }
  workflow[14] = { class_type: 'SaveImage', inputs: { images: ['13', 0], filename_prefix: prefix } }

  return { workflow, outputNodeId: '14', outputClass: 'SaveImage' }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function normalizeEditRequest(args, config) {
  const raw = args && typeof args === 'object' ? args : {}
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
  if (!prompt) {
    throw new ImagePluginError(
      CODES.BAD_ARGS,
      '缺少 prompt（要改成什么）',
      '示例：edit_image({ image: "a.png", mask: "mask.png", prompt: "把头盔改成哑光黑，加一道橙色反光条" })'
    )
  }
  const image = typeof raw.image === 'string' ? raw.image.trim() : typeof raw.input_image === 'string' ? raw.input_image.trim() : ''
  if (!image) {
    throw new ImagePluginError(CODES.BAD_ARGS, '缺少 image（输入图路径）', '传一张本地 PNG 的路径')
  }
  const mask = typeof raw.mask === 'string' ? raw.mask.trim() : ''
  const color = typeof raw.color === 'string' ? raw.color.trim() : ''
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) {
    throw new ImagePluginError(
      CODES.BAD_ARGS,
      `color 不是合法的十六进制颜色：${color}`,
      '精确改色请传 #RRGGBB，例如 #E00000；要按文字描述重画就不要传 color'
    )
  }
  const mode = color && mask ? 'recolor' : 'generative'

  const { name: presetName, preset } = presetFor(raw.preset || config.defaults.preset)
  const useMask = Boolean(mask)
  const denoise = clampNumber(raw.denoise, 0.05, 1, useMask ? 0.85 : 0.55)

  const negativePrompt = typeof raw.negative_prompt === 'string' ? raw.negative_prompt.trim() : ''
  let cfgScale = Number(raw.cfg_scale != null ? raw.cfg_scale : 1)
  if (!Number.isFinite(cfgScale)) cfgScale = 1
  if (negativePrompt && cfgScale === 1) cfgScale = 4

  const steps = Math.round(
    clampNumber(raw.steps, 1, 80, Number(preset.steps) || config.defaults.steps)
  )
  const seedInput = raw.seed != null ? Number(raw.seed) : -1
  const seed = Number.isInteger(seedInput) && seedInput >= 0 ? seedInput : Math.floor(Math.random() * 2147483646) + 1

  return {
    image,
    mask,
    color,
    mode,
    prompt,
    finalPrompt: prompt,
    negativePrompt,
    useMask,
    denoise,
    preset: { name: presetName, ...preset },
    steps,
    seed,
    cfgScale,
    sampler: raw.sampler_name || preset.sampler,
    scheduler: raw.scheduler || preset.scheduler,
    maxSide: Math.round(clampNumber(raw.max_side, 256, 1536, 1024)),
    outputPath: typeof raw.output_path === 'string' ? raw.output_path.trim() : '',
    timeoutMs: Math.round(clampNumber(raw.timeout_ms, 10000, 3600000, config.defaults.timeoutMs))
  }
}

/** mask 外平均绝对差（三通道平均），用来验证“只改了该改的地方”。 */
export function maskOutsideDiff(before, after, mask) {
  if (before.width !== after.width || before.height !== after.height) {
    return { comparable: false, reason: '尺寸不同' }
  }
  if (mask.width !== after.width || mask.height !== after.height) {
    return { comparable: false, reason: '遮罩尺寸不同' }
  }
  let inside = 0
  let insideCount = 0
  let outside = 0
  let outsideCount = 0
  for (let i = 0; i < before.width * before.height; i += 1) {
    const m = mask.data[i * 4]
    const d =
      (Math.abs(before.data[i * 4] - after.data[i * 4]) +
        Math.abs(before.data[i * 4 + 1] - after.data[i * 4 + 1]) +
        Math.abs(before.data[i * 4 + 2] - after.data[i * 4 + 2])) /
      3
    if (m > 128) {
      inside += d
      insideCount += 1
    } else {
      outside += d
      outsideCount += 1
    }
  }
  return {
    comparable: true,
    inside: insideCount ? inside / insideCount : null,
    outside: outsideCount ? outside / outsideCount : null,
    maskPixels: insideCount,
    totalPixels: insideCount + outsideCount
  }
}

/**
 * 精确改色：把 mask 内的像素按原图明暗映射成目标颜色。
 *
 * 这条路不跑模型，专门处理“只换一个平涂颜色、线条和按钮必须原样保留”的
 * 局部修改。遮罩里的黑色线稿亮度接近 0，会保持黑；米白面板会变成饱和色，
 * 明暗和高光关系不变。mask 外的像素一个都不动。
 */
export function recolorMasked(source, mask, hex) {
  const target = [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ]
  const scaledMask =
    mask.width === source.width && mask.height === source.height
      ? mask
      : resize(mask, source.width, source.height)
  const out = new Uint8Array(source.data)
  for (let i = 0; i < source.width * source.height; i += 1) {
    const m = scaledMask.data[i * 4]
    if (!m) continue
    const r = source.data[i * 4]
    const g = source.data[i * 4 + 1]
    const b = source.data[i * 4 + 2]
    const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    const shade = Math.pow(luma, 0.85)
    const alpha = m / 255
    for (let c = 0; c < 3; c += 1) {
      const tinted = target[c] * shade
      out[i * 4 + c] = Math.round(tinted * alpha + source.data[i * 4 + c] * (1 - alpha))
    }
  }
  return { image: { width: source.width, height: source.height, data: out }, mask: scaledMask }
}

/**
 * 跑一次图生图/局部修改。
 * @returns {Promise<object>} 和 runGeneration 同形的结果，额外带 diff
 */
export async function runEdit(options) {
  const log = options.log || (() => {})
  const startedAt = Date.now()
  const config = options.config || resolveConfig()
  const request = normalizeEditRequest(options.args, config)

  const cwd = options.cwd || process.cwd()
  const resolvePath = (value) => {
    const expanded = expandHome(value)
    return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded)
  }
  const imageFile = resolvePath(request.image)
  const maskFile = request.mask ? resolvePath(request.mask) : ''
  const source = readPng(imageFile, '输入图')
  const mask = maskFile ? readPng(maskFile, '遮罩') : null
  const size =
    request.mode === 'recolor'
      ? { width: source.width, height: source.height }
      : fitEditSize(source.width, source.height, request.maxSide)

  const plan = planOutput({
    outputPath: request.outputPath,
    cwd,
    defaultDir: path.join(config.outputDir || path.join(cwd, 'gen'), 'edits'),
    seed: request.seed
  })

  if (request.mode === 'recolor') {
    const recolored = recolorMasked(source, mask, request.color)
    fs.mkdirSync(path.dirname(plan.file), { recursive: true })
    fs.writeFileSync(plan.file, encodePng(recolored.image.width, recolored.image.height, recolored.image.data))
    const gate = gateImage(plan.file, {
      width: size.width,
      height: size.height,
      expectAlpha: false
    })
    const diff = maskOutsideDiff(source, recolored.image, recolored.mask)
    if (diff.comparable) {
      gate.checks.push({
        name: 'mask_outside_consistency',
        ok: diff.outside <= MASK_OUTSIDE_TOLERANCE,
        detail: `mask 外平均变化 ${diff.outside.toFixed(2)}（阈值 ${MASK_OUTSIDE_TOLERANCE}）`
      })
      gate.passed = gate.checks.every((check) => check.ok)
    }
    const timing = { queueMs: 0, sampleMs: 0, downloadMs: 0, totalMs: Date.now() - startedAt }
    const meta = {
      plugin: 'dsh-qwen-image',
      tool: 'edit_image',
      mode: 'recolor',
      createdAt: new Date().toISOString(),
      request: { ...request, width: size.width, height: size.height },
      source: { file: imageFile, width: source.width, height: source.height, bytes: source.bytes },
      mask: { file: maskFile, width: mask.width, height: mask.height, bytes: mask.bytes },
      color: request.color,
      timing,
      gate,
      diff,
      file: plan.file,
      bytes: fs.statSync(plan.file).size
    }
    const sidecar = writeSidecar(plan.file, meta)
    log(`精确改色完成：${request.color} → ${plan.file}`)
    return {
      request: { ...request, width: size.width, height: size.height },
      mode: 'recolor',
      source: meta.source,
      mask: meta.mask,
      file: plan.file,
      files: [plan.file, sidecar],
      sidecar,
      gate,
      diff,
      promptId: null,
      color: request.color,
      timing,
      models: config.models,
      server: null,
      workflow: null
    }
  }

  const server = await ensureServer(config, { log })
  const client = new ComfyClient(server.baseUrl)
  await assertComfyReady(client, { preset: request.preset }, config.models)

  const imageName = stageFile(config.comfy.root, imageFile, 'src')
  const maskName = maskFile ? stageFile(config.comfy.root, maskFile, 'mask') : ''
  const built = buildEditWorkflow({
    request: { ...request, width: size.width, height: size.height, finalPrompt: request.finalPrompt },
    models: config.models,
    imageName,
    maskName,
    prefix: `dsh-qwen-edit/${timestamp()}-${request.seed}`
  })

  const submitAt = Date.now()
  const promptId = await client.submit(built.workflow)
  log(`已提交编辑 prompt_id=${promptId}`)
  const { images } = await client.waitFor(promptId, {
    timeoutMs: request.timeoutMs,
    signal: options.signal
  })
  const sampledAt = Date.now()
  const saved = await client.download(images[0], plan.file)
  const downloadedAt = Date.now()

  const gate = gateImage(plan.file, {
    width: size.width,
    height: size.height,
    expectAlpha: false
  })

  let diff = null
  if (mask) {
    const after = readPng(plan.file, '输出图')
    const beforeScaled = resize(source, size.width, size.height)
    const maskScaled = resize(mask, size.width, size.height)
    diff = maskOutsideDiff(beforeScaled, after, maskScaled)
    if (diff.comparable) {
      gate.checks.push({
        name: 'mask_outside_consistency',
        ok: diff.outside <= MASK_OUTSIDE_TOLERANCE,
        detail: `mask 外平均变化 ${diff.outside.toFixed(2)}（阈值 ${MASK_OUTSIDE_TOLERANCE}）`
      })
      gate.passed = gate.checks.every((check) => check.ok)
    }
  }

  const timing = {
    queueMs: submitAt - startedAt,
    sampleMs: sampledAt - submitAt,
    downloadMs: downloadedAt - sampledAt,
    totalMs: downloadedAt - startedAt
  }
  const meta = {
    plugin: 'dsh-qwen-image',
    tool: 'edit_image',
    createdAt: new Date().toISOString(),
    request: { ...request, width: size.width, height: size.height },
    source: { file: imageFile, width: source.width, height: source.height, bytes: source.bytes },
    mask: mask ? { file: maskFile, width: mask.width, height: mask.height, bytes: mask.bytes } : null,
    models: built.resolvedModels || config.models,
    workflow: built.workflow,
    promptId,
    server: { baseUrl: server.baseUrl, startedByUs: server.startedByUs },
    timing,
    gate,
    diff,
    file: plan.file,
    bytes: saved.bytes
  }
  const sidecar = writeSidecar(plan.file, meta)
  scheduleIdleShutdown(config, { log })

  return {
    request: { ...request, width: size.width, height: size.height },
    source: meta.source,
    mask: meta.mask,
    file: plan.file,
    files: [plan.file, sidecar],
    sidecar,
    gate,
    diff,
    promptId,
    timing,
    models: config.models,
    server,
    workflow: built.workflow
  }
}

function omitUndefined(value) {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key]
  return value
}

export function formatEditResult(run) {
  const { request, file, files, gate, diff, promptId, timing, source, mask, server, mode } = run
  const seconds = (timing.totalMs / 1000).toFixed(1)
  const lines = []
  if (mode === 'recolor') {
    lines.push(
      `已精确改色 1 张 ${request.width}×${request.height} 图片（${request.color}，保留原图线条与明暗）`
    )
  } else {
    lines.push(
      `${mask ? '已局部修改' : '已图生图'} 1 张 ${request.width}×${request.height} 图片（${request.preset.name} 档 / ${request.steps} 步 / denoise ${request.denoise} / seed ${request.seed}）`
    )
  }
  lines.push(`输入图：${source.file}（${source.width}×${source.height}）`)
  if (mask) lines.push(`遮罩：${mask.file}`)
  lines.push(`图片：${file}`)
  lines.push(`![编辑结果](${toFileUrl(file)})`)
  lines.push(`用时 ${seconds}s，门禁${summarizeGate(gate)}`)
  if (diff && diff.comparable) {
    lines.push(
      `遮罩内平均变化 ${diff.inside.toFixed(2)}，遮罩外平均变化 ${diff.outside.toFixed(2)}（阈值 ${MASK_OUTSIDE_TOLERANCE}）`
    )
  }
  if (server && server.startedByUs) lines.push('本次由插件自动启动了 ComfyUI（空闲后会自动关闭）')
  if (mode === 'recolor') {
    lines.push(
      `复现：edit_image({ image: "${source.file}", mask: "${mask.file}", color: "${request.color}", prompt: "${request.prompt}" })`
    )
  } else {
    lines.push(`复现：edit_image({ image: "${source.file}", ${mask ? `mask: "${mask.file}", ` : ''}prompt: "${request.prompt}", seed: ${request.seed} })`)
  }
  return omitUndefined({
    text: lines.join('\n'),
    path: file,
    files,
    source_path: source.file,
    mask_path: mask ? mask.file : '',
    preset: request.preset.name,
    seed: request.seed,
    width: request.width,
    height: request.height,
    steps: request.steps,
    denoise: request.denoise,
    prompt_id: promptId || undefined,
    duration_ms: timing.totalMs,
    mask_inside_diff: diff && diff.comparable ? diff.inside : undefined,
    mask_outside_diff: diff && diff.comparable ? diff.outside : undefined,
    gate: {
      passed: gate.passed === true,
      summary: summarizeGate(gate),
      checks: (gate.checks || []).map((check) => `${check.name}:${check.ok ? 'ok' : 'fail'}`)
    },
    success: gate.passed === true
  })
}
