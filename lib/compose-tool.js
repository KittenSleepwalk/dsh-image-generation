/** 工具：compose_prompts —— 按「配图提示词生成SKILL」把一句需求展开成多组提示词。 */

import { composePrompts, listCatalog, analyzeBrief } from './prompt-angles.js'
import { buildConstraints, buildRepairBlock, buildChecklist } from './constraints.js'
import { logDebug } from './log.js'

export const COMPOSE_TOOL_NAME_DEFAULT = 'compose_prompts'

export const COMPOSE_TOOL_DESCRIPTION = [
  '按「配图提示词生成SKILL」把一句需求展开成**多组释义版本**（语义维 2–3 解读 × 每版 ≥4 风格）的已组装提示词（静态逻辑，不出图）。',
  '用途：用户需求有歧义、或要同题多风格时，先用本工具生成方案，再把 prompts 交给 generate_variants 出图。',
  '',
  '它会做三件事：',
  '  1. 语义三分类：LOCK（方位/数量/顺序/传递/否定/精确文字，必须照做）、可释义（循环/策略/历史/抽象…按关系表达，禁止字面符号化）、自由（风格/配色/构图）；',
  '     还会识别流程动词（读取→计算→选取→接到→继续→完成）并生成编号步骤约束；',
  '     并把「不能错」的部分编译成**带编号的约束**（C1 层数/方向、C2 箭头精确数量、C3 每层内容白名单、C4+ 额外硬约束、文字策略、科普禁令），',
  '     每条约束都带 verify 验收标准，渲染成 MUST-FOLLOW CONSTRAINTS 编号块；',
  '  2. 角度展开：从风格（9 家族 40+ 细类）、图型（16 种骨架 + 混合规则）、比例、构图、密度、文字策略、配色里选组合；',
  '  2.1 参考图与底案：自动匹配 docs/参考图（…）.png；若存在同名的「底案（…）.png」（无文字版），只把底案的构图/画法作为参考，',
  '      参考图说明与「文字参考（…）.md」进 spec；画面只留空文字框、不渲染文字（SKILL H：图像与文字分离）；',
  '      风格 Top-k 强制来自不同分类（默认 4 个分类）；文字策略默认「无文字」（模型写中文标签不稳，标签留给 PPT 后期加）；',
  '     每个释义版本落在不同的「释义 × 风格 × 图型 × 比例」组合上；可释义词（循环/策略/历史…）按词库展开 2–3 种关系表达；',
  '  3. 每条变体带 label（释义 n｜风格 × 图型 · 比例）、interpretation、negative、静态自检结果（validation）与「适合/风险」说明；',
  '     每个释义版本默认铺 4 种风格（SKILL 策略）→ 版本数 × 4 条提示词；',
  '     再配合 generate_variants 的 seeds_per_prompt 出多张（每条 × N 个随机种子）；',
  '  4. action=repair：上一轮图哪条约束没过，把 constraint id 传进来，输出 CORRECTIONS 修复块，追加到原 prompt 后重新出图。',
  '',
  '参数：',
  '  brief             用户需求原话（必填）',
  '  must_keep         额外硬约束数组，例如 ["每两层之间各一根向上短箭头","共三根，不要贯穿大箭头"]',
  '  styles            风格 id 数组（不传则按语义自动选）；id 见 list 动作',
  '  forms             图型 id 数组（不传自动）；d1 叠层 / d2 框架 / d3 时间线 / d4 管道 …',
  '  ratios            比例 id 数组（16:9 / 3:4 / 1:1 …）',
  '  count             释义版本数：默认取 SKILL 策略上限（3），可调 1–8',
  '  density           minimal / medium / dense',
  '  text_policy       none / few-labels / exact',
  '  palette           blue-violet-cyan / warm-dark / mono-accent / pastel / dark-neon / paper',
  '  composition       centered / thirds / left-text / top-bottom / grid / safe-title',
  '  interpretations   自定义释义说明（不传则用可释义词库自动展开）',
  '  failed            action=repair 时：上一轮未通过的约束 id 数组，例如 ["C2","C3"]',
  '',
  'action=list 时返回可用风格/图型/比例/参考图清单。'
].join('\n')

export const COMPOSE_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['compose', 'list', 'repair'], description: 'compose=组装提示词（默认）；list=查看可用风格/图型/比例；repair=生成失败项修复块' },
    brief: { type: 'string', description: '用户需求原话（compose 必填）' },
    must_keep: { type: 'array', items: { type: 'string' }, description: '额外硬约束（Agent 从需求里提炼的不能错项）' },
    styles: { type: 'array', items: { type: 'string' }, description: '风格 id 列表，例如 c1-glass / c2-clay / c3-schematic' },
    forms: { type: 'array', items: { type: 'string' }, description: '图型 id 列表，例如 d1 / d4 / d2+d3' },
    ratios: { type: 'array', items: { type: 'string' }, description: '比例 id 列表，例如 16:9 / 3:4 / 1:1' },
    count: { type: 'integer', description: '释义版本数：默认取 SKILL 策略上限（3），可调 1–8' },
    styles_per_version: { type: 'integer', description: '每个释义版本铺几种风格：默认 4、最多 4' },
    density: { type: 'string', description: '信息密度 minimal / medium / dense' },
    text_policy: { type: 'string', description: '文字策略 none / few-labels / exact' },
    palette: { type: 'string', description: '配色 id' },
    composition: { type: 'string', description: '构图 id' },
    interpretations: { type: 'array', items: { type: 'string' }, description: '歧义词选定释义说明' },
    failed: { type: 'array', items: { type: 'string' }, description: 'action=repair 时：上一轮未通过的约束 id，例如 ["C2","C3"]' },
    negative: { type: 'string', description: '自定义负面提示词（覆盖默认模板）' }
  },
  required: [],
  additionalProperties: false
}

export const COMPOSE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '给模型看的汇总（分析结论 + 每条变体）' },
    count: { type: 'integer', description: '生成的变体数（提示词条数 = 版本数 × 每版风格数）' },
    versions: { type: 'integer', description: '释义版本数' },
    stylesPerVersion: { type: 'integer', description: '每版风格数' },
    totalImages: { type: 'integer', description: '提示词条数（×4 种子即总出图数）' },
    variants: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          prompt: { type: 'string' },
          negative: { type: 'string' },
          ratio: { type: 'string' },
          interpretation: { type: 'string' }
        },
        required: ['label', 'prompt', 'ratio'],
        additionalProperties: false
      },
      description: '每条变体：label / prompt / negative / ratio / interpretation（至少 6 条）'
    },
    notes: { type: 'array', items: { type: 'string' }, description: '语义分析与组合说明' },
    constraints: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          text: { type: 'string' },
          verify: { type: 'string' }
        },
        required: ['id', 'text', 'verify'],
        additionalProperties: false
      },
      description: '编号约束（C1 层数方向 / C2 箭头数量 / C3 每层内容白名单 / C4+ 硬约束 / 文字策略 / 科普禁令）'
    },
    checks: { type: 'array', items: { type: 'string' }, description: '出图后逐条核对清单' }
  },
  required: ['text', 'count', 'variants'],
  additionalProperties: false
}

function formatCatalog(catalog) {
  const lines = ['可用角度：']
  lines.push('')
  lines.push(`风格（${catalog.styles.length}）：`)
  for (const family of [...new Set(catalog.styles.map((style) => style.family))]) {
    const items = catalog.styles.filter((style) => style.family === family)
    lines.push(`  ${family}: ${items.map((style) => style.id).join(' / ')}`)
  }
  lines.push('')
  lines.push(`图型（${catalog.forms.length}）：` + catalog.forms.map((form) => `${form.id}=${form.name}`).join(' / '))
  lines.push(`比例：${catalog.ratios.map((ratio) => ratio.id).join(' / ')}`)
  lines.push(`构图：${catalog.compositions.map((item) => item.id).join(' / ')}`)
  lines.push(`密度：${catalog.densities.map((item) => item.id).join(' / ')}`)
  lines.push(`文字：${catalog.textPolicies.map((item) => item.id).join(' / ')}`)
  lines.push(`配色：${catalog.palettes.map((item) => item.id).join(' / ')}`)
  lines.push(`提示词要素（SKILL 流程）：${(catalog.promptFlow || []).join(' / ')}`)
  lines.push(`文字规则：${catalog.textRules && catalog.textRules.separate ? '图像/文字分离，画面留空文字框（字体后期用' + (catalog.textRules.font || '黑体/雅黑') + '）' : '未解析'}`)
  lines.push(`附录样例：${catalog.appendixCount || 0} 条`)
  lines.push('')
  lines.push('混合规则：' + catalog.mixRules.map((rule) => `${rule.name}(${rule.pair.join('+')})`).join('；'))
  return lines.join('\n')
}

export function createComposePromptsTool(pluginConfig) {
  const toolName = (pluginConfig && pluginConfig.composeToolName) || COMPOSE_TOOL_NAME_DEFAULT
  return {
    name: toolName,
    description: COMPOSE_TOOL_DESCRIPTION,
    parameters: COMPOSE_PARAMETERS_SCHEMA,
    output: {
      schema: COMPOSE_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }]
    },
    async execute(args) {
      const input = args || {}
      const action = input.action || 'compose'
      logDebug('compose-tool', { action })
      if (action === 'list') {
        const catalog = listCatalog()
        return { text: formatCatalog(catalog), count: 0, variants: [], notes: [] }
      }
      if (action === 'repair') {
        const brief = String(input.brief || '')
        const analysis = analyzeBrief(brief)
        const set = buildConstraints({
          brief,
          analysis,
          mustKeep: input.must_keep,
          textPolicy: input.text_policy || 'few-labels'
        })
        const block = buildRepairBlock(Array.isArray(input.failed) ? input.failed : [], set.constraints)
        if (!block) {
          return { text: '没有可修复项：请在 failed 里传上一轮未通过的约束 id（如 ["C2","C3"]）', count: 0, variants: [], notes: [], constraints: [], checks: [] }
        }
        const text = [
          '已生成修复块，请追加到上一轮确认要重出的 prompt 后面，再调 generate_variants：',
          '',
          block,
          '',
          '约束对照（逐条核对）：',
          ...set.constraints.map((constraint) => `  [${constraint.id}] ${constraint.verify}`)
        ].join('\n')
        return {
          text,
          count: 0,
          variants: [],
          notes: [],
          constraints: set.constraints.map((constraint) => ({ id: constraint.id, type: constraint.type, text: constraint.text, verify: constraint.verify })),
          checks: buildChecklist(set.constraints).map((check) => `${check.id}: ${check.check}`)
        }
      }
      const result = composePrompts({
        brief: input.brief,
        mustKeep: input.must_keep,
        styles: input.styles,
        forms: input.forms,
        ratios: input.ratios,
        count: input.count,
        stylesPerVersion: input.styles_per_version,
        density: input.density,
        textPolicy: input.text_policy,
        palette: input.palette,
        composition: input.composition,
        interpretations: input.interpretations,
        negative: input.negative
      })
      const lines = [`已生成 ${result.variants.length} 条提示词（${result.versions} 个释义版本 × 每版 ${result.stylesPerVersion} 种风格）。`]
      if (result.interpretations && result.interpretations.length) {
        lines.push(`释义池：${result.interpretations.length} 种表达`)
      }
      if (result.stages.length) lines.push(`自动分层清单：${result.stages.map((stage) => stage.name).join(' → ')}`)
      if (result.analysis.locks.length) {
        lines.push('')
        lines.push('识别到的硬约束：')
        for (const lock of result.analysis.locks) lines.push(`  - ${lock.type}: ${lock.value}（${lock.evidence}）`)
      }
      if (result.analysis.ambiguities.length) lines.push(`歧义词：${result.analysis.ambiguities.join(' / ')}（请按所选释义确认）`)
      for (const note of result.notes) lines.push(`注意：${note}`)
      lines.push('')
      lines.push('MUST-FOLLOW 编号约束（出图后逐条核对）：')
      for (const constraint of result.constraints) lines.push(`  [${constraint.id}] ${constraint.verify}`)
      for (const variant of result.variants) {
        lines.push('')
        lines.push(`【${variant.label}】`)
        if (variant.interpretation) lines.push(`释义：${variant.interpretation}`)
        lines.push(variant.prompt)
        if (variant.validation && !variant.validation.ok) lines.push(`⚠ 生成前自检未通过：${variant.validation.missing.join('；')}`)
        if (variant.note) lines.push(`说明：${variant.note}`)
      }
      lines.push('')
      lines.push(`下一步出图：把这些 prompt 交给 generate_variants，传 seeds_per_prompt=4、min_images=${result.variants.length * 4}，`)
      lines.push(`共 ${result.variants.length} × 4 = ${result.variants.length * 4} 张；出图后按上面的约束逐条核对，未通过的用 action=repair 传 failed 约束 id 重出。`)
      const variants = result.variants.map((variant) => ({
        label: variant.label,
        prompt: variant.prompt,
        negative: variant.negative || '',
        ratio: variant.ratio,
        interpretation: variant.interpretation || ''
      }))
      return {
        text: lines.join('\n'),
        count: variants.length,
        versions: result.versions,
        stylesPerVersion: result.stylesPerVersion,
        totalImages: result.variants.length,
        variants,
        notes: result.notes,
        constraints: result.constraints,
        checks: result.checks.map((check) => `${check.id}: ${check.check}`)
      }
    }
  }
}
