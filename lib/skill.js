/**
 * SKILL 加载器：把人工编写的 Markdown SKILL 变成可执行配置。
 *
 * 思路：SKILL 是唯一权威文档（人写、易改），代码不复制它的条文，而是**解析**：
 *   - 铁律（## 0）
 *   - 角度总表表格
 *   - 风格家族表 / 骨架表（## C）
 *   - 画幅表（## D）
 *   - 方案策略（## 3）：语义维 2–3 解读、风格维 ≥4、比例横竖各 ≥1
 * 解析结果用于 compose_prompts / generate_from_brief 的默认值，并整段拼进提示词。
 *
 * 纯本地文件解析，不发网络；文件缺失时退回内置默认（不阻塞出图）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadReferences } from './references.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..')

export const SKILL_CANDIDATES = [
  path.join(PLUGIN_ROOT, 'docs', '配图提示词生成SKILL.md'),
  path.resolve(PLUGIN_ROOT, '..', '..', '..', 'PluginGeneration', 'dsh-image-generation-ks', 'docs', '配图提示词生成SKILL.md'),
  process.env.DSH_IMAGE_SKILL || ''
].filter(Boolean)

const FALLBACK = {
  path: '',
  title: '配图提示词角度体系',
  ironRules: [
    '具象语义优先固定：实义词、方位词严格遵守，关键名词在图中用文字框或气泡框写明',
    '抽象语义发散思维：抽象/专业名词可用机器人等具象表达，但要贴合上下文',
    '风格 Top-k：同一语义至少 4 种风格，比例横竖各至少 1 版'
  ],
  angles: [],
  styleFamilies: [],
  forms: [],
  ratios: [],
  strategy: { semanticMin: 2, semanticMax: 3, stylesMin: 4, structuresMin: 1, needBothOrientations: true }
}

function parseMarkdownTable(lines) {
  const rows = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    if (/^\|[\s:|-]+\|$/.test(trimmed)) continue
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
    rows.push(cells)
  }
  return rows
}

function tableBlocks(text) {
  const lines = text.split(/\r?\n/)
  const blocks = []
  let current = []
  for (const line of lines) {
    if (line.trim().startsWith('|')) {
      current.push(line)
    } else if (current.length) {
      blocks.push(current)
      current = []
    }
  }
  if (current.length) blocks.push(current)
  return blocks.map(parseMarkdownTable).filter((rows) => rows.length > 0)
}

function sectionOf(text, headingPattern) {
  const match = text.match(headingPattern)
  if (!match) return ''
  const start = match.index + match[0].length
  const rest = text.slice(start)
  const nextHeading = rest.search(/^##\s+/m)
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading)
}

function numberFrom(text, pattern, fallback) {
  const match = String(text).match(pattern)
  return match ? Number(match[1]) : fallback
}

/** 扫描 docs 及子目录，解析「底案 → 可编辑PPT → PPT截图文字版」样例三元组 */
export function loadSamples(skillPath) {
  const dir = skillPath ? path.dirname(skillPath) : ''
  if (!dir || !fs.existsSync(dir)) return []
  const roots = [dir]
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(path.join(dir, entry.name))
    }
  } catch (error) { /* ignore */ }
  const samples = []
  for (const root of roots) {
    let files = []
    try { files = fs.readdirSync(root) } catch (error) { continue }
    const base = files.find((name) => /_底案\.(png|jpg|jpeg)$/i.test(name))
    if (!base) continue
    const screenshot = files.find((name) => /PPT截图文字版\.(png|jpg|jpeg)$/i.test(name))
    const pptx = files.find((name) => /\.pptx$/i.test(name))
    samples.push({
      dir: root,
      base: path.join(root, base),
      screenshot: screenshot ? path.join(root, screenshot) : '',
      pptx: pptx ? path.join(root, pptx) : ''
    })
  }
  return samples
}

/** 解析 docs 下的「附录：N条提示词」文件，作为 Agent 可读的样例提示词库 */
export function loadAppendix(skillPath) {
  const dir = skillPath ? path.dirname(skillPath) : ''
  if (!dir || !fs.existsSync(dir)) return []
  const file = fs.readdirSync(dir).find((name) => /^附录[：:].*\.md$/i.test(name))
  if (!file) return []
  const raw = fs.readFileSync(path.join(dir, file), 'utf8')
  const items = []
  let current = null
  for (const line of raw.split(/\r?\n/)) {
    const numbered = line.match(/^\s*(?:#{1,4}\s*)?(\d{1,2})[.、)]\s*(.+)$/)
    const bullet = line.match(/^\s*[-*]\s+(.+)$/)
    if (numbered) {
      if (current) items.push(current)
      current = { index: Number(numbered[1]), text: numbered[2].trim() }
    } else if (bullet && current) {
      current.text += ' ' + bullet[1].trim()
    }
  }
  if (current) items.push(current)
  return items.filter((item) => item.text.length >= 8)
}

export function parseSkill(raw, sourcePath = '') {
  const text = String(raw || '')
  if (!text.trim()) return { ...FALLBACK, path: sourcePath }
  const title = (text.match(/^#\s+(.+)$/m) || [])[1] || FALLBACK.title

  const ironSection = sectionOf(text, /^##\s*\d*[.、]?\s*[^\n]*铁律[^\n]*$/m)
  const ironRules = ironSection
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+[.、]/.test(line))
    .map((line) => line.replace(/^\d+[.、]\s*/, '').replace(/\*\*/g, '').replace(/；$/, '').trim())

  const allTables = tableBlocks(text)
  const byHeader = (keywords) =>
    allTables.find((rows) => rows.length > 1 && keywords.every((keyword) => rows[0].join(' ').includes(keyword))) || []

  const angleTable = byHeader(['角度'])
  const angles = angleTable
    .filter((cells) => cells.length >= 2 && /^[A-Z]$/.test(cells[0]))
    .map((cells) => ({ code: cells[0], name: cells[1], tier: cells[3] || '' }))

  const styleTable = byHeader(['细类', '适合']) .length ? byHeader(['细类', '适合']) : byHeader(['家族'])
  const styleFamilies = styleTable
    .filter((cells) => cells.length >= 4 && /^C\d/.test(cells[0]))
    .map((cells) => ({ id: cells[0].split(/\s/)[0], name: cells[0].replace(/^C\d+\s*/, ''), examples: cells[1], useFor: cells[2], risk: cells[3] }))

  const formTable = byHeader(['骨架']).length ? byHeader(['骨架']) : byHeader(['关系语义'])
  const forms = formTable
    .filter((cells) => cells.length >= 3 && /^C\d+$/.test(cells[0]))
    .map((cells) => ({ code: cells[0], name: cells[1], relation: cells[2], fit: cells[3] || '' }))

  const dSection = sectionOf(text, /^##\s*D[.、]?[^\n]*画幅[^\n]*$/m) || sectionOf(text, /^##\s*B[.、]?[^\n]*主体[^\n]*$/m)
  const ratios = parseMarkdownTable(dSection.split(/\r?\n/))
    .filter((cells) => cells.length >= 3 && /\d+\s*:\s*\d+/.test(cells[0]))
    .map((cells) => ({ ratio: cells[0], size: cells[1], useFor: cells[2], constraint: cells[3] || '' }))

  // 提示词生成流程的 7 个要素（新 SKILL ## 提示词生成流程）
  const flowSection = sectionOf(text, /^###\s*提示词生成流程[^\n]*$/m)
  const promptFlow = []
  const flowPattern = /^\s+\d+\.\s+(?:\*\*)?([^：：（(\n]+?)(?:\*\*)?\s*[（(：]/gm
  let flowMatch
  while ((flowMatch = flowPattern.exec(flowSection)) !== null) promptFlow.push(flowMatch[1].trim())
  // 只保留 7 个要素（去掉顶层的「目标与需求 / 关键信息」两项）
  promptFlow.splice(0, promptFlow.length, ...promptFlow.filter((name) => !/目标与需求|关键信息/.test(name)).slice(0, 7))

  // H 文字：图像与文字分离
  const textSection = sectionOf(text, /^##\s*H[.、]?[^\n]*文字[^\n]*$/m)
  const textRules = {
    separate: /分离图像和文字|图像和文字分离/.test(textSection) || /留足备案/.test(textSection),
    reserveBoxes: /文字框|气泡框/.test(textSection),
    leaveBase: /底案|留足备案/.test(textSection),
    font: /黑体|雅黑/.test(textSection) ? '黑体（雅黑）' : '',
    raw: textSection.replace(/\s+/g, ' ').trim().slice(0, 300)
  }

  // 附录：24 条通用提示词样例
  const appendixPrompts = []
  const docsDir = sourcePath ? path.dirname(sourcePath) : ''
  if (docsDir && fs.existsSync(docsDir)) {
    for (const name of fs.readdirSync(docsDir).filter((entry) => /^附录.*\.md$/i.test(entry))) {
      try {
        const appendixText = fs.readFileSync(path.join(docsDir, name), 'utf8')
        const promptPattern = /\*\*提示词\s*(\d+)[：:]\s*([^*]+)\*\*\s*\n+([^\n]+)/g
        let promptMatch
        while ((promptMatch = promptPattern.exec(appendixText)) !== null) {
          appendixPrompts.push({ index: Number(promptMatch[1]), title: promptMatch[2].trim(), prompt: promptMatch[3].trim() })
        }
      } catch (error) {
        // 附录读取失败不影响主流程
      }
    }
  }

  const strategySection = sectionOf(text, /^##\s*3[.、]?\s*[^\n]*方案策略[^\n]*$/m)
  const strategyText = strategySection || text
  const semanticRange = strategyText.match(/(\d+)\s*[–—-]\s*(\d+)\s*种解读/) || text.match(/(\d+)\s*[–—-]\s*(\d+)\s*种解读/)
  const stylesMin = numberFrom(strategyText, /至少\s*(?:选\s*)?(\d+)\s*种风格/, 4)
  const styleCategoriesMin = numberFrom(strategyText, /k至少设置为\s*(\d+)/, numberFrom(strategyText, /至少\s*(?:选\s*)?(\d+)\s*种风格分类/, Math.max(4, stylesMin)))
  const structuresMin = numberFrom(strategyText, /结构维[^\n]*?(\d+)\s*种/, 1)
  const needBothOrientations = /横\s*\+\s*竖\s*各至少|横竖各至少/.test(text)

  return {
    path: sourcePath,
    title,
    mtime: sourcePath && fs.existsSync(sourcePath) ? fs.statSync(sourcePath).mtimeMs : 0,
    ironRules,
    angles,
    styleFamilies,
    forms,
    ratios,
    references: loadReferences(sourcePath, text),
    textRules: {
      separate: true,
      baseImage: true,
      textLayer: true,
      font: '黑体（雅黑）',
      note: '图像与文字分离：留足空白文本框/气泡框，文字由 ComfyUI/PS/PPT 后加；留底案（纯图像）与加字后的文件；文字层字体默认黑体（雅黑）'
    },
    promptFlow: ['Subject', 'Details & attributes', 'Environment & scene', 'Art style & medium', 'Composition & camera', 'Lighting & color', 'Quality & parameters'],
    appendix: loadAppendix(sourcePath),
    samples: loadSamples(sourcePath),
    appendixCount: loadAppendix(sourcePath).length,
    promptFlow,
    textRules,
    appendixPrompts,
    appendixCount: appendixPrompts.length,
    strategy: {
      semanticMin: semanticRange ? Number(semanticRange[1]) : 2,
      semanticMax: semanticRange ? Number(semanticRange[2]) : 3,
      stylesMin: Math.max(4, stylesMin),
      styleCategoriesMin: Math.max(4, styleCategoriesMin),
      structuresMin,
      needBothOrientations
    }
  }
}

let cache = null
export function loadSkill(force = false) {
  if (cache && !force) return cache
  for (const candidate of SKILL_CANDIDATES) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, 'utf8')
        cache = parseSkill(raw, candidate)
        return cache
      }
    } catch (error) {
      // 忽略单个候选失败，继续找下一个
    }
  }
  cache = { ...FALLBACK, strategy: { ...FALLBACK.strategy }, promptFlow: [...FALLBACK.promptFlow], textRules: { ...FALLBACK.textRules }, appendixPrompts: [], appendixCount: 0 }
  return cache
}

/** 拼进提示词的 SKILL 规则块（保证「具象固定 / 抽象发散 / 关键名词标注」进入每条 prompt）。 */
export function skillPromptBlock(skill = loadSkill()) {
  const lines = []
  lines.push('SKILL RULES (from 配图提示词生成SKILL.md):')
  const rules = skill.ironRules.length
    ? skill.ironRules
    : FALLBACK.ironRules
  rules.forEach((rule, index) => lines.push(`${index + 1}) ${rule}`))
  lines.push(`Style: at least ${skill.strategy.stylesMin} distinct styles per interpretation; ratio must include one horizontal and one vertical version.`)
  return lines.join('\n')
}

/** 给工具输出用的简要摘要 */
export function skillSummary(skill = loadSkill()) {
  return [
    `SKILL：${skill.path || '（内置默认，未找到 SKILL 文件）'}`,
    `角度：${skill.angles.length} 个（${skill.angles.map((angle) => angle.name).join(' / ')}）`,
    `风格家族：${skill.styleFamilies.length}，骨架：${skill.forms.length}`,
    `参考图：${(skill.references || []).length} 张（底案：${(skill.references || []).filter((ref) => ref.basePath).length} 张）；底案→PPT→截图样例：${(skill.samples || []).length} 组`,
    `提示词要素：${(skill.promptFlow || []).length} 项；文字规则：${skill.textRules && skill.textRules.separate ? '图像/文字分离，留空文字框' : '未解析'}；附录样例：${skill.appendixCount || 0} 条`,
    `策略：语义维 ${skill.strategy.semanticMin}–${skill.strategy.semanticMax} 种解读；风格维 ≥${skill.strategy.styleCategoriesMin} 个分类；比例横竖各 ≥1`
  ].join('\n')
}

/** 默认出图配置：由 SKILL 策略推导，供 compose / 批量工具使用 */
export function skillDefaults() {
  const skill = loadSkill()
  return {
    versions: Math.max(6, skill.strategy.semanticMin * 2),
    stylesPerVersion: skill.strategy.stylesMin,
    needBothOrientations: skill.strategy.needBothOrientations,
    skill
  }
}

export const SKILL_RESOURCE_PATH = path.join(PLUGIN_ROOT, 'docs', '配图提示词生成SKILL.md')
