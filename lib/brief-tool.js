/**
 * 工具：generate_from_brief —— 按 SKILL 生成多组提示词，再一次性交给本地绘图模型出图。
 *
 * 这是「SKILL → 提示词 → 出图」的一步到位入口：
 *   1. 读取 docs/配图提示词生成SKILL.md（铁律/角度/风格/骨架/比例策略）；
 *   2. composePrompts 按 SKILL 策略生成多组释义版本（语义维 2–3 × 每版 ≥4 风格）；
 *   3. 每条按 seeds_per_prompt 复制随机种子（默认 4）→ 条数 × 4 张；
 *   4. 串行排队出图，返回每张图的路径/seed/门禁。
 *
 * dry_run=true 时只生成提示词与出图计划，不真正调用绘图模型（用于先审方案）。
 */

import { resolveConfig } from './config.js'
import { composePrompts } from './prompt-angles.js'
import { loadSkill, skillSummary } from './skill.js'
import { expandVariantSeeds } from './variants-tool.js'
import { runVariants } from './batch.js'
import { renderFailureText } from './result.js'
import { logDebug } from './log.js'

export const BRIEF_TOOL_NAME_DEFAULT = 'generate_from_brief'

export const BRIEF_TOOL_DESCRIPTION = [
  '按「配图提示词生成SKILL」把一句需求生成**多组提示词**，并直接调用本地绘图模型批量出图（一步到位）。',
  '规则来源：docs/配图提示词生成SKILL.md（具象语义固定 + 抽象语义发散 + 风格 Top-k + 横竖比例各至少 1 版）。',
  '',
  '流程：',
  '  1. 读 SKILL → 2. 按语义维 2–3 种解读 × 每版 ≥4 种风格（默认 3×4=12 条，可用 count 调大）',
  '  → 3. 每条提示词 × seeds_per_prompt 个随机种子（默认 4）→ 12×4=48 张',
  '  → 4. 串行排队出图，返回图片路径/seed/门禁结果。',
  '',
  '参数：',
  '  brief              用户需求原话（必填）',
  '  must_keep          额外硬约束（Agent 提炼的「不能错」项）',
  '  count              释义版本数（默认取 SKILL 策略上限 3，可调 1–8）',
  '  seeds_per_prompt   每条提示词几个随机种子（默认 4；=1 则每条只出一张）',
  '  max_images         上限保护（默认 120）：超出直接报错，避免误启动超长队列',
  '  dry_run            true=只返回提示词与出图计划，不真正出图（建议先 dry_run 审方案）',
  '  preset             绘图档位（默认 fast；正式稿用 standard/quality）',
  '  output_path        输出目录（默认插件配置的 outputDir）',
  '',
  '批量规模参考：默认 12 条 × 4 种子 = 48 张，fast 档约 10–18 分钟（串行）。'
].join('\n')

export const BRIEF_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    brief: { type: 'string', description: '用户需求原话' },
    must_keep: { type: 'array', items: { type: 'string' }, description: '额外硬约束' },
    count: { type: 'integer', description: '释义版本数（默认取 SKILL 策略上限 3，可调 1–8）' },
    seeds_per_prompt: { type: 'integer', description: '每条提示词随机种子数（默认 4）' },
    max_images: { type: 'integer', description: '出图上限保护（默认 120）' },
    dry_run: { type: 'boolean', description: '只生成提示词与计划，不出图' },
    preset: { type: 'string', description: '绘图档位 fast/standard/turbo/quality/transparent' },
    output_path: { type: 'string', description: '输出目录' }
  },
  required: ['brief'],
  additionalProperties: false
}

export const BRIEF_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '汇总文本（SKILL 信息 + 提示词 + 出图计划/结果）' },
    promptCount: { type: 'integer', description: '提示词条数' },
    imageCount: { type: 'integer', description: '实际出图张数（dry_run 时为 0）' },
    dryRun: { type: 'boolean' },
    files: { type: 'array', items: { type: 'string' }, description: '产物文件（图片 + sidecar）' },
    success: { type: 'boolean', description: '是否全部通过门禁（dry_run 视为 true）' }
  },
  required: ['text', 'promptCount', 'imageCount', 'dryRun', 'files', 'success'],
  additionalProperties: false
}

export function createGenerateFromBriefTool(pluginConfig) {
  const bootConfig = resolveConfig(pluginConfig)
  const toolName = bootConfig.briefToolName || BRIEF_TOOL_NAME_DEFAULT
  return {
    name: toolName,
    description: BRIEF_TOOL_DESCRIPTION,
    parameters: BRIEF_PARAMETERS_SCHEMA,
    output: {
      schema: BRIEF_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      presentationMeta: (_args, value) => ({
        kind: 'image-generation',
        path: (value && value.files && value.files[0]) || '',
        count: (value && value.imageCount) || 0
      })
    },
    async execute(args, exec) {
      const input = args || {}
      const skill = loadSkill()
      const config = resolveConfig(pluginConfig)
      logDebug('brief-tool', { dryRun: input.dry_run === true })
      try {
        const composed = composePrompts({
          brief: input.brief,
          mustKeep: input.must_keep,
          count: input.count,
          skill
        })
        const seedsPerPrompt = Math.max(1, Math.min(8, Number(input.seeds_per_prompt) || 4))
        const expanded = expandVariantSeeds(composed.variants, seedsPerPrompt).map((variant) => ({
          ...variant,
          aspect_ratio: variant.aspect_ratio || variant.ratio
        }))
        const maxImages = Math.max(1, Number(input.max_images) || 120)
        const planned = expanded.length
        const lines = [skillSummary(skill), '', `提示词：${composed.variants.length} 条（${composed.versions} 版本 × 每版 ${composed.stylesPerVersion} 风格）`]
        lines.push(`出图计划：${planned} 张（每条 × ${seedsPerPrompt} 种子）`)
        if (planned > maxImages) {
          throw new Error(`计划出图 ${planned} 张，超过上限 ${maxImages}；请减小 count/seeds_per_prompt 或调大 max_images`)
        }
        const sample = composed.variants.slice(0, 3).map((variant) => `  - ${variant.label}`)
        lines.push('提示词示例：')
        lines.push(...sample)
        if (input.dry_run === true) {
          lines.push('')
          lines.push('dry_run=true：未调用绘图模型。确认方案后去掉 dry_run 再调用即可批量出图。')
          return { text: lines.join('\n'), promptCount: composed.variants.length, imageCount: 0, dryRun: true, files: [], success: true }
        }
        const run = await runVariants({
          variants: expanded,
          cwd: input.output_path || config.outputDir || config.comfy.cwd,
          config,
          signal: exec && exec.signal ? exec.signal : undefined,
          log: (message) => logDebug('brief', message)
        })
        lines.push('')
        lines.push(`已出图 ${run.results.length} 张（总耗时 ${(run.totalMs / 1000).toFixed(1)}s）：`)
        for (const item of run.results) {
          lines.push(`  #${item.index} ${item.label} · seed ${item.seed} · ${item.width}×${item.height} · 门禁${item.gate ? '通过' : '未通过'}`)
          lines.push(`     ${item.file}`)
        }
        const files = []
        for (const item of run.results) {
          files.push(item.file)
          if (item.sidecar) files.push(item.sidecar)
        }
        return {
          text: lines.join('\n'),
          promptCount: composed.variants.length,
          imageCount: run.results.length,
          dryRun: false,
          files,
          success: run.results.every((item) => item.gate)
        }
      } catch (error) {
        throw new Error(renderFailureText(error))
      }
    }
  }
}
