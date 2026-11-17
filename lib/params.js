/** 参数归一化：把 Agent 传进来的散参数收成一个确定性的 request 对象。 */

import { presetFor, sizeFor, align32 } from './presets.js'
import { ImagePluginError, CODES } from './errors.js'

/** 透明背景的官方写法：不接抠图节点，纯提示词包装。 */
export function wrapTransparentPrompt(prompt) {
  const body = String(prompt || '').trim().replace(/[.。\s]+$/, '')
  return (
    'This is an RGBA format image with transparency. ' +
    `${body}. ` +
    'The image has an alpha channel and the background is transparent.'
  )
}

function randomSeed() {
  return Math.floor(Math.random() * 2147483646) + 1
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, n))
}

/**
 * @param {object} args   工具入参
 * @param {object} config 已解析的配置
 * @returns {object} 归一化后的 request
 */
export function normalizeRequest(args, config) {
  const raw = args && typeof args === 'object' ? args : {}
  const notes = []

  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
  if (!prompt) {
    throw new ImagePluginError(
      CODES.BAD_ARGS,
      '缺少 prompt（要画什么）',
      '示例：generate_image({ prompt: "赛璐璐风格的柯基宇航员，纯色背景" })'
    )
  }

  const { name: presetName, preset } = presetFor(raw.preset || config.defaults.preset)
  const transparent = raw.transparent === true || preset.transparent === true

  // 尺寸：显式 width/height 优先，否则按档位 + 比例查表
  let width
  let height
  let aspectRatio = raw.aspect_ratio || config.defaults.aspectRatio || '1:1'
  if (raw.width != null || raw.height != null) {
    const fallback = sizeFor(preset, aspectRatio)
    width = align32(raw.width != null ? raw.width : fallback.width)
    height = align32(raw.height != null ? raw.height : fallback.height)
    aspectRatio = raw.aspect_ratio || `${(width / height).toFixed(2)}`
  } else {
    const size = sizeFor(preset, aspectRatio)
    width = size.width
    height = size.height
    aspectRatio = size.aspectRatio
  }

  const negativePrompt = typeof raw.negative_prompt === 'string' ? raw.negative_prompt.trim() : ''
  // 步数：显式入参 > 档位定义（standard 40 / turbo 8 / fast 25），config.defaults.steps 只是没给档位时的兜底
  const presetSteps = Number(preset.steps)
  const steps = clampInt(
    raw.steps != null ? raw.steps : Number.isFinite(presetSteps) ? presetSteps : config.defaults.steps,
    1,
    80
  )
  let cfgScale = Number(raw.cfg_scale != null ? raw.cfg_scale : config.defaults.cfgScale)
  if (!Number.isFinite(cfgScale)) cfgScale = 1
  if (negativePrompt && cfgScale === 1) {
    cfgScale = 4
    notes.push('传了 negative_prompt，cfg 自动从 1 提到 4（cfg=1 时官方不使用负向提示词）')
  }

  const seedInput = raw.seed != null ? Number(raw.seed) : -1
  const seed = Number.isInteger(seedInput) && seedInput >= 0 ? seedInput : randomSeed()

  const request = {
    prompt,
    finalPrompt: transparent ? wrapTransparentPrompt(prompt) : prompt,
    negativePrompt,
    transparent,
    preset: { name: presetName, ...preset },
    width,
    height,
    aspectRatio,
    steps,
    cfgScale,
    sampler: raw.sampler_name || preset.sampler,
    scheduler: raw.scheduler || preset.scheduler,
    seed,
    outputPath: typeof raw.output_path === 'string' ? raw.output_path.trim() : '',
    timeoutMs: clampInt(raw.timeout_ms != null ? raw.timeout_ms : config.defaults.timeoutMs, 10000, 3600000),
    notes
  }
  return request
}
