/** 编排：解析参数 → 保证服务 → 校验模型/节点 → 提交 → 等图 → 取回 → 门禁 → sidecar。 */

import { ComfyClient } from './comfy.js'
import { ensureServer, scheduleIdleShutdown } from './server.js'
import { normalizeRequest } from './params.js'
import { buildText2Img, describeModels } from './workflow.js'
import { planOutput, timestamp, writeSidecar } from './files.js'
import { gateImage } from './gate.js'
import { ImagePluginError, CODES } from './errors.js'

function pickChoices(objectInfo, nodeClass, keys) {
  const info = objectInfo && objectInfo[nodeClass]
  if (!info) return []
  const required = (info.input && info.input.required) || {}
  for (const key of keys) {
    const entry = required[key]
    if (entry && Array.isArray(entry[0])) return entry[0]
  }
  return []
}

/** 提交前的快速自检：节点在不在、模型文件有没有被 ComfyUI 扫到。 */
export async function assertComfyReady(client, request, models) {
  const encoder = await client.objectInfo('TextEncodeQwenImage21').catch(() => null)
  if (!encoder || !encoder.TextEncodeQwenImage21) {
    throw new ImagePluginError(
      CODES.MISSING_NODE,
      'ComfyUI 里没有 TextEncodeQwenImage21 节点',
      '需要 ComfyUI ≥ 0.37.0（本机 0.40.0 已满足）；若刚升级/刚装插件，请重启 ComfyUI 与 DSH'
    )
  }

  const wanted = describeModels(request, models)
  const unetInfo = await client.objectInfo('UNETLoader').catch(() => null)
  const unetChoices = pickChoices(unetInfo, 'UNETLoader', ['unet_name', 'ckpt_name'])
  const clipInfo = await client.objectInfo('CLIPLoader').catch(() => null)
  const clipChoices = pickChoices(clipInfo, 'CLIPLoader', ['clip_name'])
  const clipTypes = pickChoices(clipInfo, 'CLIPLoader', ['type'])
  const vaeInfo = await client.objectInfo('VAELoader').catch(() => null)
  const vaeChoices = pickChoices(vaeInfo, 'VAELoader', ['vae_name'])

  const problems = []
  if (unetChoices.length && !unetChoices.includes(wanted.unet)) problems.push(`diffusion_models/${wanted.unet}`)
  if (clipChoices.length && !clipChoices.includes(wanted.clip)) problems.push(`text_encoders/${wanted.clip}`)
  if (vaeChoices.length && !vaeChoices.includes(wanted.vae)) problems.push(`vae/${wanted.vae}`)
  if (clipTypes.length && !clipTypes.includes('qwen_image')) {
    throw new ImagePluginError(
      CODES.MISSING_NODE,
      'CLIPLoader 的 type 列表里没有 qwen_image',
      'ComfyUI 版本过旧，升级到 0.40.0'
    )
  }
  if (problems.length) {
    throw new ImagePluginError(
      CODES.MISSING_MODEL,
      `ComfyUI 的模型列表里没有：${problems.join('、')}`,
      '把权重复制到 ComfyUI/models 对应目录后重启 ComfyUI（模型目录只在启动时扫描）；' +
        '本机下载器见 PluginGeneration/dsh-image-generation-ks/scripts/download-qwen21.ps1'
    )
  }
  return { wanted }
}

/**
 * @param {object} options
 * @param {object} options.args    工具入参
 * @param {string} options.cwd     会话工作目录
 * @param {object} options.config  resolveConfig 的结果
 * @param {AbortSignal} [options.signal]
 * @param {(msg: string) => void} [options.log]
 */
export async function runGeneration(options) {
  const log = options.log || (() => {})
  const startedAt = Date.now()

  const request = normalizeRequest(options.args, options.config)
  const plan = planOutput({
    outputPath: request.outputPath,
    cwd: options.cwd,
    defaultDir: options.config.outputDir,
    seed: request.seed
  })

  const server = await ensureServer(options.config, { log })
  const client = new ComfyClient(server.baseUrl)
  await assertComfyReady(client, request, options.config.models)

  const built = buildText2Img({
    request,
    models: options.config.models,
    keepComfyOutput: options.config.keepComfyOutput,
    useLatentCache: options.config.useLatentCache,
    filenamePrefix: `dsh-qwen-image/${timestamp()}-${request.seed}`
  })

  const submitAt = Date.now()
  const promptId = await client.submit(built.workflow)
  log(`已提交 prompt_id=${promptId}`)
  const { images } = await client.waitFor(promptId, {
    timeoutMs: request.timeoutMs,
    signal: options.signal
  })
  const sampledAt = Date.now()

  const saved = await client.download(images[0], plan.file)
  const downloadedAt = Date.now()

  const gate = gateImage(plan.file, {
    width: request.width,
    height: request.height,
    expectAlpha: request.transparent === true
  })

  const timing = {
    queueMs: submitAt - startedAt,
    sampleMs: sampledAt - submitAt,
    downloadMs: downloadedAt - sampledAt,
    totalMs: downloadedAt - startedAt
  }

  const meta = {
    plugin: 'dsh-qwen-image',
    createdAt: new Date().toISOString(),
    request,
    models: built.resolvedModels,
    workflow: built.workflow,
    outputClass: built.outputClass,
    promptId,
    server: { baseUrl: server.baseUrl, startedByUs: server.startedByUs },
    timing,
    gate,
    file: plan.file,
    bytes: saved.bytes,
    comfyOutputKept: options.config.keepComfyOutput === true
  }
  const sidecar = writeSidecar(plan.file, meta)

  // 出图完成后再排空闲关闭（首图不要刚启动就被算空闲）
  scheduleIdleShutdown(options.config, { log })

  return {
    request,
    file: plan.file,
    files: [plan.file, sidecar],
    sidecar,
    gate,
    promptId,
    timing,
    models: built.resolvedModels,
    server,
    workflow: built.workflow
  }
}
