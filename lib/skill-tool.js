/** 工具：read_prompt_skill / plan_prompts —— 让 LLM 直接读 SKILL，并把多组提示词分给子智能体。 */

import { loadSkill, skillSummary } from './skill.js'
import { composePrompts } from './prompt-angles.js'
import { renderFailureText } from './result.js'
import { logDebug } from './log.js'

export const SKILL_TOOL_NAME_DEFAULT = 'read_prompt_skill'
export const PLAN_TOOL_NAME_DEFAULT = 'plan_prompts'

export const SKILL_TOOL_DESCRIPTION = [
  '读取插件内置的《配图提示词生成SKILL》（docs/配图提示词生成SKILL.md 全文 + 解析摘要）。',
  '',
  '什么时候必须调用：',
  '  - 用户要求「画配图/示意图/科普图/PPT 配图」等需求级出图，且你还没读过本 SKILL；',
  '  - 用户抱怨出图风格单一、释义单一、不符合预期；',
  '  - 准备调用 plan_prompts / generate_from_brief 之前。',
  '',
  '返回：SKILL 全文 + 摘要（铁律/角度/风格分类/参考图/样例/策略）。读完按 SKILL 的「方案策略」执行：',
  '  语义维 2–3 种解读 × 风格维 ≥4 个不同分类 × 结构维 × 比例维（横竖各 ≥1）。'
].join('\n')

export const SKILL_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    full: { type: 'boolean', description: 'true=返回 SKILL 全文（默认 true）；false=只返回摘要' }
  },
  required: [],
  additionalProperties: false
}

export const SKILL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'SKILL 全文或摘要' },
    path: { type: 'string', description: 'SKILL 文件路径' },
    strategy: { type: 'string', description: '方案策略摘要' }
  },
  required: ['text', 'path', 'strategy'],
  additionalProperties: false
}

export const PLAN_TOOL_DESCRIPTION = [
  '按 SKILL 把一句需求展开成**多组提示词**，用于分发给多个子智能体并行出图。',
  '',
  'SKILL 要求（本工具已内置）：语义维 2–3 种解读 × 风格维 ≥4 个不同分类 × 结构维 × 比例维（横竖各 ≥1）。',
  '',
  '返回：groups[]，每组对应一种风格分类（4 组），每组内含该风格的提示词列表（默认 3 条释义版本）；',
  '每个子智能体拿 1 组 prompts 调 generate_variants 出图，最后由主智能体统一核对/汇总。',
  '',
  '推荐工作流：',
  '  read_prompt_skill → plan_prompts → 为每个 group 派生一个子智能体（各自 generate_variants）',
  '  → 主智能体 read_image 逐张核对 + 用 assemble_captions / export_ppt 组装文字版。',
  '',
  '也可以不分子智能体：直接 generate_from_brief（同一套计划，串行出图）。',
  '',
  '参数：brief（必填）、must_keep、count（释义版本数，默认 3）、styles_per_version（默认 4，固定 4 个分类）。'
].join('\n')

export const PLAN_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    brief: { type: 'string', description: '用户需求原话' },
    must_keep: { type: 'array', items: { type: 'string' }, description: '额外硬约束' },
    count: { type: 'integer', description: '释义版本数（默认 3，可调 1–8）' },
    styles_per_version: { type: 'integer', description: '风格数（固定 4 个不同分类）' }
  },
  required: ['brief'],
  additionalProperties: false
}

export const PLAN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '计划说明 + 分组提示词' },
    groupCount: { type: 'integer', description: '风格分组数' },
    promptCount: { type: 'integer', description: '提示词总条数' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          style: { type: 'string' },
          family: { type: 'string' },
          prompts: { type: 'array', items: { type: 'string' } },
          ratios: { type: 'array', items: { type: 'string' } }
        },
        required: ['style', 'family', 'prompts'],
        additionalProperties: false
      }
    }
  },
  required: ['text', 'groupCount', 'promptCount', 'groups'],
  additionalProperties: false
}

export function createReadPromptSkillTool() {
  return {
    name: SKILL_TOOL_NAME_DEFAULT,
    description: SKILL_TOOL_DESCRIPTION,
    parameters: SKILL_PARAMETERS_SCHEMA,
    output: {
      schema: SKILL_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }]
    },
    async execute(args) {
      const input = args || {}
      const skill = loadSkill(true)
      const summary = skillSummary(skill)
      let full = ''
      try {
        const fs = await import('node:fs')
        full = fs.existsSync(skill.path) ? fs.readFileSync(skill.path, 'utf8') : ''
      } catch (error) { /* ignore */ }
      const text = input.full === false || !full ? summary : `${summary}\n\n===== SKILL 全文 =====\n${full}`
      return { text, path: skill.path || '', strategy: `语义维 ${skill.strategy.semanticMin}–${skill.strategy.semanticMax} 解读；风格维 ≥${skill.strategy.styleCategoriesMin} 个分类；比例横竖各 ≥1` }
    }
  }
}

export function createPlanPromptsTool(pluginConfig) {
  return {
    name: PLAN_TOOL_NAME_DEFAULT,
    description: PLAN_TOOL_DESCRIPTION,
    parameters: PLAN_PARAMETERS_SCHEMA,
    output: {
      schema: PLAN_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }]
    },
    async execute(args) {
      const input = args || {}
      logDebug('plan-tool', { brief: String(input.brief || '').slice(0, 40) })
      try {
        if (!input.brief) throw new Error('缺少 brief（用户需求原话）')
        const result = composePrompts({
          brief: input.brief,
          mustKeep: input.must_keep,
          count: input.count,
          stylesPerVersion: input.styles_per_version
        })
        const groups = new Map()
        for (const variant of result.variants) {
          const key = variant.styleId
          if (!groups.has(key)) {
            groups.set(key, { style: variant.styleId, family: variant.styleFamily || '', prompts: [], ratios: [] })
          }
          const group = groups.get(key)
          group.prompts.push(variant.prompt)
          if (!group.ratios.includes(variant.ratio)) group.ratios.push(variant.ratio)
        }
        const groupList = [...groups.values()]
        const lines = [
          `已按 SKILL 生成 ${result.variants.length} 条提示词，分 ${groupList.length} 组（风格分类互不相同）：`,
          `释义版本：${result.versions}；每版风格：${result.stylesPerVersion}；参考图：${(result.references || []).length} 张`,
          '',
          '分发方式（每个子智能体一组，互不重复）：'
        ]
        groupList.forEach((group, index) => {
          lines.push('')
          lines.push(`【组 ${index + 1}】风格：${group.style}（${group.family}）· ${group.prompts.length} 条`)
          lines.push(`  子智能体任务：generate_variants({ variants: 组内 prompts（可带 ratio）, seeds_per_prompt: 1 })`)
          group.prompts.forEach((prompt, promptIndex) => {
            lines.push(`  --- prompt ${promptIndex + 1} ---`)
            lines.push(prompt)
          })
        })
        lines.push('')
        lines.push('主智能体汇总：read_image 逐张核对约束 → assemble_captions（直接 PNG 文字版）或 export_ppt（可编辑 PPT）。')
        return {
          text: lines.join('\n'),
          groupCount: groupList.length,
          promptCount: result.variants.length,
          groups: groupList
        }
      } catch (error) {
        throw new Error(renderFailureText(error))
      }
    }
  }
}
