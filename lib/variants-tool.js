/** 工具：generate_variants —— 一次生成多个「猜想方案」，每个方案一张图，交给用户挑。 */

import { resolveConfig } from './config.js'
import { runVariants } from './batch.js'
import { formatResult, renderFailureText } from './result.js'
import { toFileUrl } from './files.js'
import { logDebug } from './log.js'

export const VARIANTS_TOOL_NAME_DEFAULT = 'generate_variants'

export const VARIANTS_TOOL_DESCRIPTION = [
  '一次生成多个「方案」的图片：适合用户的描述有歧义、或风格/构图有多种合理猜想时，把每种猜想都出一张交给用户挑。',
  '',
  '使用流程（重要）：',
  '  1. 先理解用户想要什么，列出 2–4 种**明显不同**的合理解读（构图/风格/主体侧重/氛围）。',
  '  2. 把每种解读细化成一条高质量提示词（主体 + 风格 + 构图 + 光线 + 配色 + 画幅），写进 variants；',
  '     每条给一个简短 label（例如“写实侧逆光”“扁平插画”“特写质感”），方便用户对照。',
  '  3. 调本工具一次性生成（串行排队，一次调用最多 8 个方案）。',
  '  4. 生成后用 read_image **逐张检查**是否符合用户意图，把结果连同每张图的 label/seed 汇报给用户；',
  '     只有**全部方案都明显偏差**时，才回头向用户确认需求，不要一上来就追问。',
  '',
  '参数 variants：数组，每项可以是纯提示词字符串，也可以是对象：',
  '  { label, prompt, preset?, aspect_ratio?, width?, height?, steps?, seed?, transparent? }',
  '外层也可以给统一的 preset / aspect_ratio 等，作为所有方案的默认值。',
  '',
  '返回：每个方案的图片路径、seed、耗时、门禁结果；图片文件同目录带 .json sidecar 可复现。',
  '',
  '批量出图建议：先用 compose_prompts 生成多组提示词（语义维 2–3 解读 × 每版 ≥4 风格），',
  '  再调本工具传 seeds_per_prompt（每条 × N 个随机种子）；min_images 可用于张数校验。',
  '  生成是串行排队，数量多时耗时较长（热态每张约 10–20 秒，以实际为准）。'
].join('\n')

const VARIANT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string', description: '方案简称，例如“写实侧逆光”“扁平插画”' },
    prompt: { type: 'string', description: '该方案细化后的高质量提示词' },
    preset: { type: 'string', description: '可选档位 fast/standard/turbo/quality/transparent' },
    aspect_ratio: { type: 'string', description: '可选比例，例如 1:1 / 16:9 / 3:4' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    steps: { type: 'integer' },
    seed: { type: 'integer' },
    transparent: { type: 'boolean' }
  },
  required: ['prompt'],
  additionalProperties: false
}

export const VARIANTS_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    variants: {
      type: 'array',
      items: VARIANT_ITEM_SCHEMA,
      description: '每项可以只给 prompt，或给 {label,prompt,...}（可配合 compose_prompts 的多组提示词）'
    },
    preset: { type: 'string', description: '所有方案的默认档位（不传 standard）' },
    aspect_ratio: { type: 'string', description: '所有方案的默认比例' },
    steps: { type: 'integer', description: '所有方案的默认步数' },
    seeds_per_prompt: { type: 'integer', description: '每个提示词随机生成几个种子（默认 1；批量规则要求 ≥4）' },
    min_images: { type: 'integer', description: '最少出图张数校验：不足直接报错' },
    output_path: { type: 'string', description: '输出目录（默认 <会话工作目录>/gen 或插件配置的 outputDir）' }
  },
  required: ['variants'],
  additionalProperties: false
}

export const VARIANTS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '给模型看的汇总（含每张图路径与 label）' },
    count: { type: 'integer', description: '实际生成的方案数' },
    files: { type: 'array', items: { type: 'string' }, description: '全部产物（图片 + sidecar）' },
    success: { type: 'boolean', description: '是否全部通过门禁' }
  },
  required: ['text', 'count', 'files', 'success'],
  additionalProperties: false
}

/** 把批量结果排版成给 Agent/用户看的文本。 */
export function formatVariantsResult(run) {
  const lines = []
  lines.push(`已生成 ${run.results.length} 个方案（总耗时 ${(run.totalMs / 1000).toFixed(1)}s）：`)
  for (const item of run.results) {
    lines.push('')
    lines.push(`方案 ${item.index} · ${item.label}`)
    lines.push(`  图片：${item.file}`)
    lines.push(`  ${item.width}×${item.height} · ${item.preset} · ${item.steps} 步 · seed ${item.seed} · ${(item.durationMs / 1000).toFixed(1)}s · 门禁${item.gate ? '通过' : '未通过'}`)
  }
  lines.push('')
  lines.push('下一步：用 read_image 逐张检查是否符合意图，再让用户挑；只有全部偏差才追问需求。')
  const files = []
  for (const item of run.results) {
    files.push(item.file)
    if (item.sidecar) files.push(item.sidecar)
  }
  return {
    text: lines.join('\n'),
    count: run.results.length,
    files,
    success: run.results.every((item) => item.gate)
  }
}

/** 扩展种子：每条 prompt 复制 seedsPerPrompt 份，各自一个随机 seed。 */
export function expandVariantSeeds(variants, seedsPerPrompt) {
  const count = Math.max(1, Math.min(8, Number(seedsPerPrompt) || 1))
  const expanded = []
  for (const variant of variants) {
    for (let copy = 0; copy < count; copy += 1) {
      const seed = copy === 0 && typeof variant.seed === 'number' ? variant.seed : Math.floor(Math.random() * 2 ** 31)
      expanded.push({
        ...variant,
        label: count > 1 ? `${variant.label} · seed#${copy + 1}` : variant.label,
        seed
      })
    }
  }
  return expanded
}

export function createGenerateVariantsTool(pluginConfig) {
  const bootConfig = resolveConfig(pluginConfig)
  const toolName = bootConfig.variantsToolName || VARIANTS_TOOL_NAME_DEFAULT
  return {
    name: toolName,
    description: VARIANTS_TOOL_DESCRIPTION,
    parameters: VARIANTS_PARAMETERS_SCHEMA,
    output: {
      schema: VARIANTS_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      presentationMeta: (_args, value) => ({
        kind: 'image-generation',
        path: (value && value.files && value.files[0]) || '',
        count: (value && value.count) || 0
      })
    },
    async execute(args, exec) {
      const config = resolveConfig(pluginConfig)
      const raw = args || {}
      const applied = Array.isArray(raw.variants)
        ? raw.variants.map((item) => {
            const base = typeof item === 'string' ? { prompt: item } : { ...item }
            if (raw.preset && !base.preset) base.preset = raw.preset
            if (raw.aspect_ratio && !base.aspect_ratio) base.aspect_ratio = raw.aspect_ratio
            if (raw.steps != null && base.steps == null) base.steps = raw.steps
            if (raw.output_path && !base.output_path) base.output_path = raw.output_path
            if (!base.aspect_ratio && base.ratio) base.aspect_ratio = base.ratio
            return base
          })
        : []
      const expanded = expandVariantSeeds(applied, raw.seeds_per_prompt)
      const minImages = Number(raw.min_images) || 0
      if (minImages > 0 && expanded.length < minImages) {
        throw new Error(`出图数量不足：当前计划 ${expanded.length} 张（${applied.length} 提示词 × ${Math.max(1, Number(raw.seeds_per_prompt) || 1)} 种子），要求至少 ${minImages} 张`)
      }
      logDebug('variants-tool', { prompts: applied.length, images: expanded.length })
      try {
        const run = await runVariants({
          variants: expanded,
          cwd: resolveCwdSafe(exec),
          config,
          signal: exec && exec.signal ? exec.signal : undefined,
          log: (message) => logDebug('variants', message)
        })
        return formatVariantsResult(run)
      } catch (error) {
        throw new Error(renderFailureText(error))
      }
    }
  }
}

function resolveCwdSafe(exec) {
  const agent = exec && exec.agent
  if (agent) {
    const candidates = [agent.cwd, agent.meta && agent.meta.cwd, agent.session && agent.session.cwd]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate
    }
  }
  return process.cwd()
}

export { formatResult }
