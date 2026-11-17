/**
 * 参考图库：把 docs 里的「参考图（说明）.png」变成提示词可用的风格锚点。
 *
 * 依据：用户实测——纯抽象描述画不出「科普 PPT 配图」该有的样子；参考图提供的是
 * **视觉语言**（手绘马克笔信息图 / 矢量分层图 / 中文标签框 / 分层色带 / 箭头 / 留白），
 * 所以提示词里要显式要求「按参考图的视觉语言画」，而不是让模型自由发挥。
 *
 * 解析来源：
 *   1) 参考图文件名：「参考图（<内容说明>）.png」
 *   2) SKILL 正文里的 ![](参考图...png) 链接（与说明文字相邻）
 */

import fs from 'node:fs'
import path from 'node:path'

const REF_FILE_PATTERN = /^参考图（(.+)）\.(png|jpg|jpeg|webp)$/i

/** 视觉语言共性：从这组参考图归纳出来的要求（写进每条提示词） */
export const REFERENCE_STYLE_RULES = [
  'hand-drawn marker infographic with clean vector elements, cream or white paper background, generous white space',
  'short Chinese labels inside rounded text boxes / callouts, legible hand-written style, placed right next to the element they describe',
  'one accent color per layer/band plus a neutral base; flat color fills or translucent colored bands',
  'thin black arrows between stages, small doodle icons and simple shapes instead of photorealistic detail',
  'consistent left-to-right or bottom-to-top reading order, each element clearly separated and never overlapping'
]

/** 底案 / 文字参考文件名模式（SKILL H：图像与文字分离） */
const BASE_PATTERN = /^底案（(.+)）\.(png|jpg|jpeg|webp)$/i
const TEXT_PATTERN = /^文字参考（(.+)）\.md$/i

export function basePathFor(refPath, annotation) {
  const dir = path.dirname(refPath)
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    const candidate = path.join(dir, `底案（${annotation}）.${ext}`)
    if (fs.existsSync(candidate)) return candidate
  }
  return ''
}

export function textPathFor(refPath, annotation) {
  const candidate = path.join(path.dirname(refPath), `文字参考（${annotation}）.md`)
  return fs.existsSync(candidate) ? candidate : ''
}

function fileKind(file) {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.png') return 'png'
  if (ext === '.jpg' || ext === '.jpeg') return 'jpg'
  return 'webp'
}

/** 从说明文字里抽关键词：按标点切分，留 2 字以上片段 */
export function keywordsOf(annotation) {
  return String(annotation || '')
    .split(/[：:，,。；;、（）()“”"'《》\s→→]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 30)
}

export function parseReferenceFile(filePath) {
  const name = path.basename(filePath)
  const match = name.match(REF_FILE_PATTERN)
  if (!match) return null
  const annotation = match[1].trim()
  return {
    id: name.replace(/\.(png|jpg|jpeg|webp)$/i, ''),
    name,
    path: filePath,
    annotation,
    keywords: keywordsOf(annotation),
    kind: fileKind(name),
    basePath: basePathFor(filePath, annotation),
    textPath: textPathFor(filePath, annotation)
  }
}

/** 扫目录 + 解析 SKILL 里的图片链接，合并去重 */
export function loadReferences(skillPath, skillText = '') {
  const refs = []
  const seen = new Set()
  const push = (ref) => {
    if (!ref || seen.has(ref.name)) return
    seen.add(ref.name)
    refs.push(ref)
  }

  const dir = skillPath ? path.dirname(skillPath) : ''
  if (dir && fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      push(parseReferenceFile(path.join(dir, name)))
    }
  }

  // SKILL 正文里的 ![](参考图...png)，允许绝对路径
  const linkPattern = /!\[[^\]]*\]\(([^)]*参考图[^)]*\.(?:png|jpg|jpeg|webp))\)/gi
  let match
  while ((match = linkPattern.exec(String(skillText || ''))) !== null) {
    const linked = path.resolve(dir, path.basename(match[1].replace(/\\/g, '/')))
    if (fs.existsSync(linked)) push(parseReferenceFile(linked))
    else push(parseReferenceFile(path.basename(match[1])))
  }
  return refs
}

/** 依据需求文字给参考图打分，取最相关的 k 张 */
export function matchReferences(brief, references, limit = 2) {
  const text = String(brief || '')
  const scored = []
  for (const ref of references || []) {
    let score = 0
    for (const keyword of ref.keywords) {
      if (text.includes(keyword)) score += Math.min(4, keyword.length)
    }
    // 说明越长越具体，作为弱加权
    scored.push({ ref, score: score + ref.annotation.length / 200 })
  }
  scored.sort((a, b) => b.score - a.score)
  const picked = scored.filter((item) => item.score > 0).slice(0, limit)
  return (picked.length ? picked : scored.slice(0, limit)).map((item) => item.ref)
}

/** 参考图的短风格关键词：只描述画法，不提“文字/标签”，避免模型把提示词写成正文 */
export const REFERENCE_STYLE_KEYWORDS =
  'hand-drawn marker infographic, cream paper background, colored layer bands, flat color fills, small doodle icons, thin black arrows, generous white space, clean editorial PPT style'

/** 依据匹配到的参考图返回短风格描述 */
export function referenceStyleKeywords() {
  return REFERENCE_STYLE_KEYWORDS
}

/** 渲染成提示词块：要求「按参考图的视觉语言」，但不照抄内容 */
export function referenceBlock(references) {
  if (!references || !references.length) return ''
  const lines = ['REFERENCE VISUAL LANGUAGE (match the style of these reference images; do NOT copy their content):']
  for (const ref of references) {
    lines.push(ref.basePath ? `- composition base (text-free): ${ref.annotation}` : `- ${ref.annotation}`)
  }
  lines.push('- reserve empty rounded label boxes or callouts where captions belong; do NOT render any text')
  lines.push(...REFERENCE_STYLE_RULES.filter((rule) => !/label|text/i.test(rule)).map((rule) => `- ${rule}`))
  return lines.join('\n')
}

/** 读取全部底案与文字参考文件（供 PPT 加字层使用） */
export function loadReferenceAssets(dir) {
  const bases = []
  const texts = []
  if (!dir || !fs.existsSync(dir)) return { bases, texts }
  for (const name of fs.readdirSync(dir)) {
    if (BASE_PATTERN.test(name)) bases.push({ name, path: path.join(dir, name), annotation: name.match(BASE_PATTERN)[1] })
    else if (TEXT_PATTERN.test(name)) texts.push({ name, path: path.join(dir, name), annotation: name.match(TEXT_PATTERN)[1] })
  }
  return { bases, texts }
}

export function referenceSummary(references) {
  return (references || []).map((ref) => ref.annotation)
}
