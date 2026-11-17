/**
 * 多方案批量出图：把「多个已经细化好的提示词」依次送进 ComfyUI 队列，
 * 每个方案出一张图并写 sidecar，最后一次性返回。
 *
 * 对应需求：先理解用户想法 → 猜几种可能 → 每种细化成高质量提示词 → 挨个生成 → 交给用户挑。
 * 「理解/猜想/细化」由 Agent（LLM）完成；这里只负责可靠的排队与产出。
 */

import { ComfyClient } from './comfy.js'
import { ensureServer, scheduleIdleShutdown } from './server.js'
import { normalizeRequest } from './params.js'
import { buildText2Img } from './workflow.js'
import { planOutput, timestamp, writeSidecar } from './files.js'
import { gateImage } from './gate.js'
import { assertComfyReady } from './runner.js'
import { ImagePluginError, CODES } from './errors.js'

/**
 * @param {object} options
 * @param {Array<string|object>} options.variants 每一项可以是提示词字符串，或 {label,prompt,preset,aspect_ratio,...}
 * @param {string} options.cwd
 * @param {object} options.config
 * @param {AbortSignal} [options.signal]
 * @param {(msg:string)=>void} [options.log]
 * @param {(done:number,total:number,current:object)=>void} [options.onProgress]
 */
export async function runVariants(options) {
  const log = options.log || (() => {})
  const list = Array.isArray(options.variants) ? options.variants : []
  if (!list.length) {
    throw new ImagePluginError(CODES.BAD_ARGS, '缺少 variants（至少一个方案）', '每个方案是一条已经细化好的提示词')
  }
  if (list.length > 8) {
    throw new ImagePluginError(CODES.BAD_ARGS, `方案太多（${list.length}），最多 8 个`, '先挑最可能的 2–4 个方案，再按需追加')
  }

  const startedAt = Date.now()
  const server = await ensureServer(options.config, { log })
  const client = new ComfyClient(server.baseUrl)

  const results = []
  for (let index = 0; index < list.length; index += 1) {
    const raw = typeof list[index] === 'string' ? { prompt: list[index] } : list[index]
    const itemStarted = Date.now()
    const request = normalizeRequest(raw, options.config)
    const plan = planOutput({
      outputPath: raw.output_path || request.outputPath,
      cwd: options.cwd,
      defaultDir: options.config.outputDir,
      seed: request.seed
    })
    if (index === 0) await assertComfyReady(client, request, options.config.models)

    const built = buildText2Img({
      request,
      models: options.config.models,
      keepComfyOutput: options.config.keepComfyOutput,
      useLatentCache: options.config.useLatentCache,
      filenamePrefix: `ks-variant-${index + 1}-${timestamp()}`
    })
    const promptId = await client.submit(built.workflow)
    const { images } = await client.waitFor(promptId, { timeoutMs: request.timeoutMs, signal: options.signal })
    await client.download(images[0], plan.file)
    const gate = gateImage(plan.file, {
      width: request.width,
      height: request.height,
      expectAlpha: request.transparent === true
    })
    const durationMs = Date.now() - itemStarted
    const sidecar = writeSidecar(plan.file, {
      plugin: 'dsh-image-generation-ks',
      mode: 'variant',
      index: index + 1,
      label: raw.label || `方案 ${index + 1}`,
      request,
      models: built.resolvedModels,
      workflow: built.workflow,
      promptId,
      gate,
      durationMs,
      server: { baseUrl: server.baseUrl, startedByUs: server.startedByUs }
    })
    results.push({
      index: index + 1,
      label: raw.label || `方案 ${index + 1}`,
      prompt: request.prompt,
      file: plan.file,
      sidecar,
      promptId,
      seed: request.seed,
      width: request.width,
      height: request.height,
      steps: request.steps,
      preset: request.preset.name,
      transparent: request.transparent === true,
      durationMs,
      gate: gate.passed === true,
      gateChecks: (gate.checks || []).map((check) => `${check.name}:${check.ok ? 'ok' : 'fail'}`)
    })
    log(`方案 ${index + 1}/${list.length} 完成：${plan.file}`)
    if (options.onProgress) options.onProgress(index + 1, list.length, results[results.length - 1])
  }

  scheduleIdleShutdown(options.config, { log })
  return { server, results, totalMs: Date.now() - startedAt }
}
