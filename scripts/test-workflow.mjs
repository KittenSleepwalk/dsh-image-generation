/**
 * 离线单测：不联网、不启动 ComfyUI，只验证工作流/参数/门禁/模型管理这些纯逻辑。
 * 运行：node scripts/test-workflow.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { buildText2Img, NODE_IDS } from '../lib/workflow.js'
import { normalizeRequest } from '../lib/params.js'
import { resolveConfig } from '../lib/config.js'
import { pngInfo } from '../lib/gate.js'
import { listLocalModels, modelsRoot, selectModel, deleteModel, downloadModel, ROLE_FOLDERS } from '../lib/models.js'

const config = resolveConfig({}) // 只用于取 models / defaults，不碰网络
const models = config.models

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

function build(overrides = {}) {
  const request = normalizeRequest({ prompt: '一只柯基宇航员', seed: 123, ...overrides }, config)
  return {
    request,
    built: buildText2Img({
      request,
      models,
      keepComfyOutput: overrides.keepComfyOutput === true,
      useLatentCache: overrides.useLatentCache === true,
      filenamePrefix: 'test'
    })
  }
}

console.log('dsh-image-generation-ks unit tests')

check('standard: 1024² 40 步，六节点连线正确', () => {
  const { request, built } = build()
  assert.equal(request.width, 1024)
  assert.equal(request.height, 1024)
  assert.equal(request.steps, 40)
  assert.equal(request.cfgScale, 1)
  const wf = built.workflow
  assert.equal(wf[NODE_IDS.unet].class_type, 'UNETLoader')
  assert.equal(wf[NODE_IDS.clip].inputs.type, 'qwen_image')
  assert.equal(wf[NODE_IDS.encode].class_type, 'TextEncodeQwenImage21')
  assert.equal(wf[NODE_IDS.sampler].inputs.positive[0], NODE_IDS.encode)
  assert.equal(wf[NODE_IDS.sampler].inputs.positive[1], 0)
  assert.equal(wf[NODE_IDS.sampler].inputs.negative[1], 1)
  assert.equal(wf[NODE_IDS.sampler].inputs.latent_image[0], NODE_IDS.latent)
  assert.equal(wf[NODE_IDS.decode].inputs.vae[0], NODE_IDS.vae)
  assert.equal(wf[NODE_IDS.save].class_type, 'PreviewImage')
})

check('transparent: 自动包裹 RGBA 提示词', () => {
  const { request } = build({ preset: 'transparent' })
  assert.equal(request.transparent, true)
  assert.match(request.finalPrompt, /RGBA format image with transparency/)
  assert.match(request.finalPrompt, /alpha channel/)
})

check('turbo: 用 turbo DiT + w4a8 编码器 + 8 步', () => {
  const { request, built } = build({ preset: 'turbo' })
  assert.equal(request.steps, 8)
  assert.equal(built.resolvedModels.unet, models.unetTurbo)
  assert.equal(built.resolvedModels.clip, models.clipLean)
})

check('quality: 1:1 走原生 2048²', () => {
  const { request } = build({ preset: 'quality' })
  assert.equal(request.width, 2048)
  assert.equal(request.height, 2048)
})

check('aspect_ratio: 16:9 是 32 的倍数', () => {
  const { request } = build({ aspect_ratio: '16:9' })
  assert.equal(request.width % 32, 0)
  assert.equal(request.height % 32, 0)
  assert.equal(request.width, 1344)
})

check('显式尺寸会向上对齐到 32', () => {
  const { request } = build({ width: 1000, height: 700 })
  assert.equal(request.width, 1024)
  assert.equal(request.height, 704)
})

check('negative_prompt 会把 cfg 从 1 提到 4 并留说明', () => {
  const { request } = build({ negative_prompt: 'blurry' })
  assert.equal(request.cfgScale, 4)
  assert.ok(request.notes.some((note) => note.includes('cfg')))
})

check('keepComfyOutput: 改用 SaveImage 且带文件名前缀', () => {
  const { built } = build({ keepComfyOutput: true })
  assert.equal(built.workflow[NODE_IDS.save].class_type, 'SaveImage')
  assert.equal(built.workflow[NODE_IDS.save].inputs.filename_prefix, 'test')
})

check('useLatentCache: 插入 QwenImage21Cache 并改接 model', () => {
  const { built } = build({ useLatentCache: true })
  assert.equal(built.workflow[NODE_IDS.cache].class_type, 'QwenImage21Cache')
  assert.deepEqual(built.workflow[NODE_IDS.sampler].inputs.model, [NODE_IDS.cache, 0])
})

check('未知档位/比例会报错而不是静默降级', () => {
  assert.throws(() => build({ preset: 'nope' }), /未知档位/)
  assert.throws(() => build({ aspect_ratio: '7:3' }), /未知比例/)
  assert.throws(() => normalizeRequest({}, config), /缺少 prompt/)
})

check('pngInfo: 认 PNG 头 + alpha 通道', () => {
  const buffer = Buffer.alloc(33)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(1024, 16)
  buffer.writeUInt32BE(768, 20)
  buffer[24] = 8
  buffer[25] = 6
  const info = pngInfo(buffer)
  assert.equal(info.ok, true)
  assert.equal(info.width, 1024)
  assert.equal(info.height, 768)
  assert.equal(info.alpha, true)
  assert.equal(pngInfo(Buffer.from('not a png at all')).ok, false)
})

/* ─────────── 模型管理（静态逻辑） ─────────── */

check('models: 角色到目录的映射是固定的', () => {
  assert.equal(ROLE_FOLDERS.unet, 'diffusion_models')
  assert.equal(ROLE_FOLDERS.unetTurbo, 'diffusion_models')
  assert.equal(ROLE_FOLDERS.clip, 'text_encoders')
  assert.equal(ROLE_FOLDERS.clipLean, 'text_encoders')
  assert.equal(ROLE_FOLDERS.vae, 'vae')
})

check('models: 本地清单能扫到已下载的权重并标出选中项', () => {
  const local = listLocalModels(config)
  assert.ok(Array.isArray(local.items))
  if (!fs.existsSync(modelsRoot(config))) return // 没装 ComfyUI 的机器跳过
  const byName = new Map(local.items.map((item) => [item.name, item]))
  for (const [role, name] of Object.entries(local.selected)) {
    if (!name) continue
    const hit = byName.get(name)
    if (!hit) continue
    assert.ok(hit.selectedFor.includes(role), `${name} 应被标记为 ${role} 的选中项`)
    assert.equal(local.selected[role], name)
  }
})

check('models: select 不存在的文件会报错', () => {
  assert.throws(() => selectModel(config, 'unet', 'definitely-not-here.safetensors'), /本地没有这个文件/)
  assert.throws(() => selectModel(config, 'nope', 'x.safetensors'), /未知模型角色/)
})

check('models: delete 拒绝路径越界与未知角色', () => {
  assert.throws(() => deleteModel(config, 'vae', '..\\..\\windows\\system32\\evil.dll'), /路径越界|文件不存在/)
  assert.throws(() => deleteModel(config, 'nope', 'x.safetensors'), /未知模型角色/)
})

async function checkAsync(name, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

await checkAsync('models: download 校验目录与 URL', async () => {
  await assert.rejects(
    () => downloadModel(config, { url: 'https://example.com/a.safetensors', folder: '..' }),
    /不支持的目录/
  )
  await assert.rejects(
    () => downloadModel(config, { url: 'not-a-url', folder: 'vae' }),
    /缺少可下载的 url/
  )
})

await checkAsync('models: 搜索无关键词会报错', async () => {
  const { searchRemoteModels } = await import('../lib/models.js')
  await assert.rejects(() => searchRemoteModels(config, '   '), /缺少搜索关键词/)
})

console.log(`\n${passed} tests passed`)

/* ─────────── 角度体系 v2（prompt-angles） ─────────── */

import { analyzeBrief, composePrompts, listCatalog } from '../lib/prompt-angles.js'

check('angles: 能识别「逐层传递 + 纵向」硬约束', () => {
  const analysis = analyzeBrief('深度学习把信息一层层往上抽象，每一层都拿上一层的输出当自己的输入，靠下的层分辨边缘和明暗')
  assert.equal(analysis.direction, 'vertical-up')
  assert.equal(analysis.hasTransfer, true)
  assert.ok(analysis.locks.some((lock) => lock.type === 'transfer'))
  assert.ok(analysis.ambiguities.includes('抽象'))
})

check('angles: 组合器把硬约束写进 CRITICAL CONSTRAINTS', () => {
  const result = composePrompts({
    brief: '四层自下而上，每层拿上一层输出当输入',
    mustKeep: ['共三根向上短箭头'],
    count: 4
  })
  assert.equal(result.variants.length, 16)
  for (const variant of result.variants) {
    assert.ok(!variant.prompt.includes('MUST-FOLLOW'), '约束块不应进画面正文')
    const spec = variant.spec.constraints.join(' ')
    assert.match(spec, /箭头|arrow/i)
    assert.ok(spec.includes('共三根向上短箭头'))
    assert.ok(variant.ratio)
    assert.ok(variant.label.includes('·'))
  }
})

check('angles: 竖版约束不配 21:9，且方案数受上限约束', () => {
  const result = composePrompts({ brief: '一层层往上，纵向分层', count: 8 })
  assert.equal(result.variants.length, 32)
  for (const variant of result.variants) assert.notEqual(variant.ratio, '21:9')
  assert.throws(() => composePrompts({ brief: '' }), /缺少 brief/)
})

check('angles: 目录覆盖面（≥9 家族 / ≥40 风格 / 16 图型）', () => {
  const catalog = listCatalog()
  assert.ok(catalog.styles.length >= 40, '风格细类不足')
  assert.equal(new Set(catalog.styles.map((style) => style.family)).size, 9)
  assert.equal(catalog.forms.length, 16)
  assert.ok(catalog.ratios.length >= 10)
})

/* ─────────── 约束引擎（constraints.js） ─────────── */

import { buildConstraints, buildRepairBlock, buildChecklist, validatePrompt } from '../lib/constraints.js'

check('constraints: 传递关系编译成精确数量与禁止项', () => {
  const brief = '四层自下而上，每层拿上一层输出当输入'
  const analysis = analyzeBrief(brief)
  const set = buildConstraints({ brief, analysis, textPolicy: 'none' })
  const text = set.constraints.map((c) => c.text).join(' ')
  assert.match(text, /EXACTLY 3 \(three\)/)
  assert.match(text, /NEVER more than one arrow per gap/)
  assert.match(text, /NEVER one arrow spanning two or more gaps/)
  assert.ok(set.negatives.some((n) => n.includes('no more than one arrow per gap')))
})

check('constraints: 分层白名单禁止道具污染底层', () => {
  const brief = '底层分辨边缘明暗，中间层拼成轮廓部件，上层形成完整猫和车'
  const set = buildConstraints({ brief, analysis: analyzeBrief(brief), textPolicy: 'few-labels' })
  const inventory = set.constraints.find((c) => c.type === 'inventory')
  assert.ok(inventory, '缺少分层白名单约束')
  assert.match(inventory.text, /BAND 1/)
  assert.match(inventory.text, /no furniture/i)
  assert.match(inventory.text, /no lamps/i)
  assert.ok(set.negatives.some((n) => n.includes('no lamps')))
})

check('constraints: 静态自检能发现缺约束的提示词', () => {
  const brief = '一层层往上，每层拿上一层输出当输入'
  const set = buildConstraints({ brief, analysis: analyzeBrief(brief), textPolicy: 'none' })
  const good = validatePrompt(set.constraints.map((c) => `[${c.id}] ${c.text}`).join('\n'), set.constraints)
  assert.equal(good.ok, true)
  const bad = validatePrompt('a plain prompt without constraints', set.constraints)
  assert.equal(bad.ok, false)
  assert.ok(bad.missing.length > 0)
})

check('constraints: 修复块点名失败项', () => {
  const brief = '四层自下而上，每层拿上一层输出当输入'
  const set = buildConstraints({ brief, analysis: analyzeBrief(brief), textPolicy: 'none' })
  const block = buildRepairBlock(['C2'], set.constraints)
  assert.match(block, /CORRECTIONS/)
  assert.match(block, /FIX \[C2\]/)
  assert.equal(buildRepairBlock(['CX'], set.constraints), '')
  assert.equal(buildChecklist(set.constraints).length, set.constraints.length)
})

/* ─────────── 可释义发散（循环≠圆）─────────── */

import { AMBIGUOUS_LEXICON } from '../lib/prompt-angles.js'

check('semantics: 循环是可释义关系，不是必须画圆', () => {
  const brief = '模型读取当前提示、可用的历史对话与资料，计算下一个可能的结果，然后按策略选取，它把新的结果接到前文，继续循环，直到完成。'
  const analysis = analyzeBrief(brief)
  assert.equal(analysis.direction, 'cyclic')
  assert.ok(analysis.interpretable.some((entry) => entry.matched.includes('循环')), '应识别出可释义的循环')
  assert.ok(analysis.steps.length >= 3, '应识别出流程动词')
  const set = buildConstraints({ brief, analysis, textPolicy: 'none' })
  const text = set.constraints.map((constraint) => constraint.text).join('\n')
  assert.match(text, /RELATIONS, not objects/)
  assert.match(text, /NEVER one huge circle/)
  assert.match(text, /return arrow/)
  assert.ok(AMBIGUOUS_LEXICON.length >= 8)
})

check('semantics: 循环提到「圆形」只作为禁止项出现', () => {
  const brief = '继续循环'
  const analysis = analyzeBrief(brief)
  const set = buildConstraints({ brief, analysis, textPolicy: 'none' })
  const text = set.constraints.map((constraint) => constraint.text).join(' ')
  assert.ok(!/draw a big circle/i.test(text))
  assert.match(text, /not by drawing one huge circle|NEVER one huge circle/)
})

/* ─────────── SKILL 驱动的释义版本数 ─────────── */

check('compose: 默认释义版本数由 SKILL 策略决定（3），label 不重复', () => {
  const brief = '模型读取当前提示、可用的历史对话与资料，计算下一个可能的结果，然后按策略选取，它把新的结果接到前文，继续循环，直到完成。'
  const result = composePrompts({ brief })
  assert.equal(result.versions, 3)
  assert.equal(result.variants.length, 12)
  const labels = new Set(result.variants.map((variant) => variant.label))
  assert.equal(labels.size, result.variants.length, 'label 不能重复')
  assert.ok(result.interpretations.length >= 6, '释义池至少 6 种')
  assert.ok(result.variants.every((variant) => typeof variant.interpretation === 'string'))
  assert.ok(result.variants.filter((variant) => variant.interpretation).length >= 6)
})

check('compose: count 可调小（2 版本 × 4 风格 = 8 条）', () => {
  const brief = '一只猫在弹钢琴'
  const small = composePrompts({ brief, count: 2 })
  assert.equal(small.variants.length, 8)
})

check('compose: 每个释义版本的提示词都带 Interpretation 行', () => {
  const brief = '继续循环，把结果接到前文'
  const result = composePrompts({ brief })
  for (const variant of result.variants) {
    assert.ok(variant.interpretation.length > 0)
    assert.ok(variant.prompt.includes(variant.interpretation), '释义应进画面正文')
  }
})

/* ─────────── 版本 × ≥4 风格 × 4 种子 ─────────── */

import { expandVariantSeeds } from '../lib/variants-tool.js'

check('compose: 每个释义版本至少铺 4 种风格', () => {
  const brief = '继续循环，把结果接到前文'
  const result = composePrompts({ brief })
  assert.equal(result.versions, 3)
  assert.equal(result.stylesPerVersion, 4)
  assert.equal(result.variants.length, 12)
  for (let version = 1; version <= 3; version += 1) {
    const group = result.variants.filter((variant) => variant.version === version)
    assert.equal(group.length, 4, `版本 ${version} 应有 4 种风格`)
    assert.equal(new Set(group.map((variant) => variant.styleId)).size, 4, `版本 ${version} 的 4 个风格必须不同`)
  }
})

check('compose: styles_per_version 传 2 会被抬到 4', () => {
  const result = composePrompts({ brief: '一只猫在弹钢琴', stylesPerVersion: 2 })
  assert.equal(result.stylesPerVersion, 4)
  assert.equal(result.variants.length, 12)
})

check('seeds: 12 条提示词 × 4 种子 = 48 张图，且种子各不相同', () => {
  const result = composePrompts({ brief: '继续循环，把结果接到前文' })
  const expanded = expandVariantSeeds(result.variants, 4)
  assert.equal(expanded.length, 48)
  const perPrompt = new Map()
  for (const item of expanded) {
    const key = item.label.replace(/ · seed#\d+$/, '')
    if (!perPrompt.has(key)) perPrompt.set(key, [])
    perPrompt.get(key).push(item.seed)
  }
  assert.equal(perPrompt.size, 12)
  for (const [key, seeds] of perPrompt) {
    assert.equal(seeds.length, 4, `${key} 应有 4 个种子`)
    assert.equal(new Set(seeds).size, 4, `${key} 的 4 个种子必须不同`)
  }
})

/* ─────────── SKILL 代码化（skill.js） ─────────── */

import { loadSkill, parseSkill, skillPromptBlock } from '../lib/skill.js'

check('skill: 能解析 SKILL.md 的铁律 / 角度 / 风格 / 骨架 / 策略', () => {
  const skill = loadSkill(true)
  assert.ok(skill.path, 'SKILL 文件应该被找到：' + skill.path)
  assert.ok(skill.ironRules.length >= 2, '铁律至少 2 条')
  assert.ok(skill.ironRules.join(' ').includes('具象语义'))
  assert.ok(skill.ironRules.join(' ').includes('抽象语义'))
  assert.ok(skill.angles.length >= 5, '角度表至少解析出 5 行')
  assert.equal(skill.styleFamilies.length, 9, '风格家族应为 9')
  assert.ok(skill.forms.length >= 16, '骨架表至少 16 行')
  assert.equal(skill.strategy.stylesMin, 4)
  assert.equal(skill.strategy.semanticMin, 2)
  assert.equal(skill.strategy.semanticMax, 3)
  assert.equal(skill.strategy.needBothOrientations, true)
  assert.equal(skill.angles.length, 8, '新 SKILL 角度应为 8 个')
  assert.equal(skill.ironRules.length, 3, '三条铁律')
  assert.equal(skill.promptFlow.length, 7, '提示词生成流程 7 要素')
  assert.equal(skill.textRules.separate, true, 'H 文字：图像/文字分离')
  assert.ok(skill.textRules.font, 'H 文字：应记录字体（黑体/雅黑）')
  assert.ok(skill.appendixCount >= 24, '附录 24 条样例应被解析，实际 ' + skill.appendixCount)
})

check('skill: 规则块会拼进每条提示词', () => {
  const block = skillPromptBlock(loadSkill())
  assert.match(block, /SKILL RULES/)
  assert.match(block, /具象语义/)
  const result = composePrompts({ brief: '一只猫在弹钢琴' })
  assert.ok(result.skill.path.length > 0)
  assert.ok(result.skill.angles >= 5)
  assert.ok(result.variants[0].spec.constraints.some((line) => line.includes('具象语义')), 'SKILL 铁律应在 spec 里')
})

check('skill: 解析失败时退回内置默认，不阻塞', () => {
  const fallback = parseSkill('', '')
  assert.ok(fallback.ironRules.length >= 2)
  assert.equal(fallback.strategy.stylesMin, 4)
})

/* ─────────── 参考图库（references.js） ─────────── */

import { loadReferences } from '../lib/references.js'

check('references: 新参考图被解析进 SKILL', () => {
  const skill = loadSkill(true)
  assert.ok(skill.references.length >= 7, '参考图应 ≥7，实际 ' + skill.references.length)
  for (const ref of skill.references) {
    assert.ok(ref.annotation.length > 5, '参考图说明应可读：' + ref.name)
    assert.ok(ref.keywords.length > 0)
  }
  assert.ok(listCatalog().references.length >= 7)
})

check('references: 提示词带参考图视觉语言块', () => {
  const result = composePrompts({ brief: '深度学习把信息一层层往上抽象，每一层都拿上一层的输出当自己的输入' })
  assert.ok(result.references.length >= 1, '应匹配到参考图')
  const prompt = result.variants[0].prompt
  assert.match(prompt, /hand-drawn marker infographic/i)
  assert.ok(result.variants[0].spec.references.length >= 1, '参考图说明进 spec')
  assert.ok(result.skill.referenceCount >= 7)
})

check('compose: 每版 4 种风格来自不同分类（SKILL 铁律 3）', () => {
  const result = composePrompts({ brief: '继续循环，把结果接到前文' })
  const group = result.variants.filter((variant) => variant.version === 1)
  const families = new Set(group.map((variant) => variant.styleFamily))
  assert.equal(group.length, 4)
  assert.equal(families.size, 4, '4 个风格必须来自 4 个不同分类')
})

check('references: 提示词保持简短，默认禁文字（防止把约束画成正文）', () => {
  const result = composePrompts({ brief: '一只猫在弹钢琴' })
  const prompt = result.variants[0].prompt
  assert.ok(prompt.length < 1400, '提示词应保持简短，实际 ' + prompt.length)
  assert.match(prompt, /clean empty areas/i, '默认应留干净区域（框由 assemble_captions 后加）')
  assert.ok(result.variants[0].spec.textRules.separate === true)
  assert.ok(Array.isArray(result.variants[0].spec.textAssets))
  assert.match(prompt, /do NOT draw any text boxes|no text/i)
  assert.ok(!prompt.includes('SKILL RULES'))
  assert.ok(!prompt.includes('REFERENCE VISUAL LANGUAGE'))
})


/* ─────────── 参考样例（底案 → PPT → 截图） ─────────── */

check('samples: 底案-PPT-截图工作流样例被解析', () => {
  const skill = loadSkill(true)
  assert.ok(skill.samples.length >= 1, '至少 1 组样例，实际 ' + skill.samples.length)
  const sample = skill.samples[0]
  assert.ok(sample.base && sample.pptx && sample.screenshot, '样例应含底案/PPT/截图三件套')
})

import osMod from 'node:os'
import fsMod from 'node:fs'

checkAsync('ppt: 能导出可编辑 PPTX（python-pptx）', async () => {
  const { runExportPpt } = await import('../lib/ppt.js')
  const skill = loadSkill(true)
  const sample = skill.samples[0]
  const outDir = osMod.tmpdir()
  try {
    const result = await runExportPpt({
      config: {},
      baseImage: sample.base,
      labels: [
        { text: '防灾减灾', side: 'left', anchor: [0.25, 0.35], color: '#3b7ea1' },
        { text: '出行规划', side: 'right', anchor: [0.8, 0.4], color: '#3b7ea1' },
        { text: '提前知晓天气 · 减少灾害与事故损失', shape: 'footer', color: '#8a5fbf' }
      ],
      outputPath: outDir,
      basename: 'ks_ppt_test_' + Date.now()
    })
    assert.ok(fsMod.existsSync(result.pptxPath), 'PPT 文件应存在')
    assert.ok(fsMod.statSync(result.pptxPath).size > 10000, 'PPT 文件不应为空')
    fsMod.unlinkSync(result.pptxPath)
  } catch (error) {
    if (/No module named 'pptx'|python-pptx/.test(String(error.message))) {
      console.warn('  skip: python-pptx 未安装')
      return
    }
    throw error
  }
})


/* ─────────── SKILL 必读 + 多组提示词 + 合规拦截 ─────────── */

import { createReadPromptSkillTool, createPlanPromptsTool } from '../lib/skill-tool.js'
import { createGenerateImageTool } from '../lib/tool.js'

checkAsync('skill-tool: read_prompt_skill 返回 SKILL 全文与策略', async () => {
  const tool = createReadPromptSkillTool()
  const result = await tool.execute({ full: true })
  assert.ok(result.text.includes('三条铁律'))
  assert.ok(result.text.includes('提示词生成流程'))
  assert.ok(result.path.endsWith('配图提示词生成SKILL.md'))
  assert.match(result.strategy, /语义维 2–3|风格维/)
})

checkAsync('plan-tool: 按 SKILL 返回 4 组（不同分类）提示词', async () => {
  const tool = createPlanPromptsTool({})
  const result = await tool.execute({ brief: '深度学习是机器学习的一个分支，它用多层网络从大量例子中自动学会“边缘→笔触→构图”的层层特征。' })
  assert.equal(result.groupCount, 4, '应分 4 个风格分类组')
  assert.ok(result.promptCount >= 8, '提示词总数应 ≥8，实际 ' + result.promptCount)
  const families = new Set(result.groups.map((group) => group.family))
  assert.ok(families.size >= 4, '4 组风格应来自不同分类')
  assert.ok(result.groups.every((group) => Array.isArray(group.prompts) && group.prompts.length >= 1))
})

checkAsync('generate_image: 需求级提示词被 SKILL 合规拦截', async () => {
  const tool = createGenerateImageTool({})
  let blocked = false
  try {
    await tool.execute({ prompt: '深度学习是机器学习的一个分支，它用多层网络，从大量例子中自动学会“边缘→笔触→构图”的层层特征。' })
  } catch (error) {
    blocked = /SKILL 合规拦截/.test(String(error.message))
  }
  assert.equal(blocked, true, '需求级提示词应被拦截')
})


/* ─────────── 气泡框素材（透明 PNG，可拉伸） ─────────── */

import fsAsset from 'node:fs'
import pathAsset from 'node:path'
import { fileURLToPath as fileURLToPathAsset } from 'node:url'

const ASSET_ROOT = pathAsset.resolve(pathAsset.dirname(fileURLToPathAsset(import.meta.url)), '..', 'assets', 'callouts')

check('assets: 气泡框素材与 manifest 存在', () => {
  assert.ok(fsAsset.existsSync(pathAsset.join(ASSET_ROOT, 'manifest.json')), '缺 manifest.json')
  const manifest = JSON.parse(fsAsset.readFileSync(pathAsset.join(ASSET_ROOT, 'manifest.json'), 'utf8'))
  assert.equal(Object.keys(manifest.shapes).length, 7, '应有 7 种框型')
  for (const shape of ['rounded', 'bubble_left', 'bubble_right', 'bubble_top', 'bubble_bottom', 'pill', 'tag']) {
    assert.ok(fsAsset.existsSync(pathAsset.join(ASSET_ROOT, 'blue-' + shape + '.png')), '缺素材：' + shape)
  }
})
