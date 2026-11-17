/**
 * 配图提示词角度体系 v2（机器可读目录 + 组装器）
 *
 * 设计原则：
 *   1. LOCK 先于 FREE：brief 里能判定的（方位/顺序/数量/传递关系）先用「动词+位置+数量」写死；
 *   2. 风格、图型、比例、构图、密度、配色这些表达维度再展开成变体；
 *   3. 每条变体都带 label、negative 与「为什么这样锁」的说明，方便 Agent 汇报给用户。
 *
 * 这个文件是纯静态逻辑：不发网络、不读文件，可离线单测。
 */

import {
  buildConstraints,
  renderConstraintBlock,
  renderNegative,
  buildChecklist,
  validatePrompt,
  inferStages
} from './constraints.js'
import { loadSkill, skillPromptBlock } from './skill.js'
import { matchReferences, referenceBlock, referenceStyleKeywords } from './references.js'

export const STYLE_FAMILIES = [
  {
    id: 'c1',
    name: '现代矢量',
    styles: [
      { id: 'c1-flat', name: '扁平矢量', useFor: '商务汇报、通用配图', risk: '信息平淡', prompt: 'flat vector illustration, solid color blocks, no gradients, clean thick outlines, generous white space, professional infographic look' },
      { id: 'c1-swiss', name: '瑞士极简', useFor: '高级感、极低信息量', risk: '留白过头重心失衡', prompt: 'Swiss minimal design, extreme white space, strict grid alignment, one single accent color, restrained typography' },
      { id: 'c1-iso', name: '等距 3D', useFor: '结构、层级、堆叠', risk: '层级对比被立体感削弱', prompt: 'isometric illustration, 45-degree view, soft drop shadows, neatly stacked layers, crisp geometric shapes' },
      { id: 'c1-glass', name: '玻璃拟态', useFor: '科技感、层层叠加', risk: '透明度让层界不清', prompt: 'glassmorphism illustration, translucent frosted glass panels, soft glow, subtle blur, layered depth with visible boundaries' },
      { id: 'c1-blueprint', name: '蓝图线框', useFor: '工程、学术、技术稿', risk: '太冷、不适合大众', prompt: 'technical blueprint style, thin white lines on deep blue grid, engineering annotations, precise line work' },
      { id: 'c1-gradient', name: '渐变网格', useFor: '封面、氛围底图', risk: '信息承载弱', prompt: 'modern gradient mesh background, smooth color transitions, soft depth, minimal geometric foreground shapes' }
    ]
  },
  {
    id: 'c2',
    name: '卡通',
    styles: [
      { id: 'c2-picturebook', name: '绘本彩铅/水彩', useFor: '科普、有情节的类比', risk: '暗底在 PPT 里偏重', prompt: 'children picture-book illustration, colored pencil with watercolor wash, visible paper grain, warm yellow lamp light, dark chalkboard background, hand-drawn labels, cozy and vivid' },
      { id: 'c2-clay', name: '3D 软塑 IP', useFor: '面向非专业听众的流程/对比', risk: '质感抢戏、层级被稀释', prompt: '3D soft clay render, rounded glossy plastic material, cute robot IP character, pastel gradient background, soft studio lighting, bold rounded arrows' },
      { id: 'c2-flat', name: '扁平卡通', useFor: '轻量说明、社交媒体', risk: '辨识度一般', prompt: 'flat cartoon illustration, rounded shapes, simple cheerful characters, solid muted palette, no texture' },
      { id: 'c2-lowpoly', name: '低多边形', useFor: '科技、游戏感', risk: '人文内容不搭', prompt: 'low-poly 3D illustration, faceted geometric surfaces, flat shading, cool color palette' },
      { id: 'c2-papercut', name: '纸雕分层', useFor: '层层叠（亲和版）', risk: '阴影太多显脏', prompt: 'paper-cut layered illustration, multiple paper layers with soft drop shadows, crafting paper texture, clean edges' },
      { id: 'c2-pixel', name: '像素风', useFor: '底层像素层的局部语汇', risk: '整图裸像素不专业', prompt: '8-bit pixel art, chunky pixels, limited palette, crisp grid' },
      { id: 'c2-qline', name: 'Q版线描+单点色', useFor: '最省、最清楚的讲解图', risk: '过于朴素', prompt: 'minimal kawaii line art, white background, black outline, one accent color highlight, chibi proportions' },
      { id: 'c2-claymation', name: '黏土定格', useFor: '温暖、手工感', risk: '细节模糊', prompt: 'claymation stop-motion look, sculpted clay figures, visible fingerprints, warm soft light, miniature set' },
      { id: 'c2-felt', name: '毛毡', useFor: '亲和力、儿童向', risk: '信息密度低', prompt: 'felt craft illustration, fuzzy wool texture, stitched edges, soft pastel colors' }
    ]
  },
  {
    id: 'c3',
    name: '学术科研',
    styles: [
      { id: 'c3-schematic', name: '论文示意图', useFor: '讲义、论文环境', risk: '对大众不够生动', prompt: 'academic schematic diagram, thin line boxes, grayscale palette with one accent color, small I/O port squares, precise and unadorned' },
      { id: 'c3-featuremap', name: '特征可视化', useFor: '解释底层特征', risk: '像噪声、不好懂', prompt: 'feature map visualization, activation heat tiles, dot grids and stripes, grayscale to color ramp' },
      { id: 'c3-cutaway', name: '剖面技术图', useFor: '内部结构', risk: '结构复杂易错', prompt: 'technical cutaway illustration, cross-section view, labeled callout lines, clean vector style' },
      { id: 'c3-engineering', name: '工程蓝图', useFor: '结构、装配', risk: '冷硬', prompt: 'engineering drawing style, precise outlines, dimension marks, grid paper background' }
    ]
  },
  {
    id: 'c4',
    name: '叙事氛围',
    styles: [
      { id: 'c4-watercolor', name: '水彩晕染', useFor: '封面、概念', risk: '边界软、信息弱', prompt: 'soft watercolor wash illustration, bleeding edges, paper texture, muted palette' },
      { id: 'c4-cinematic', name: '电影暖光', useFor: '故事化开头', risk: '压字', prompt: 'cinematic lighting, golden hour warm light, shallow depth of field, film still composition' },
      { id: 'c4-screenprint', name: '丝网印', useFor: '海报、章节页', risk: '色彩受限', prompt: 'screen print poster style, halftone dots, limited 2-3 inks, slight offset registration' },
      { id: 'c4-retro', name: '复古海报', useFor: '复古主题', risk: '年代错位', prompt: 'mid-century retro poster, grain texture, flat shapes, warm faded palette' },
      { id: 'c4-darkneon', name: '暗调霓虹', useFor: 'AI/赛博主题', risk: '发光干扰阅读', prompt: 'dark background neon glow, cyan and magenta rim light, moody tech atmosphere' },
      { id: 'c4-artlecture', name: '艺术课讲义', useFor: '给艺术/非技术听众讲技术概念', risk: '过于艺术化丢结构', prompt: 'art-class handout style, hand-drawn watercolor texture with collage and risograph / screen-print feel, muted data-blue plus feature yellow, magenta and cyan accents, sparse nodes, short annotation boxes, studio-like props (easel, palette, canvas)' }
    ]
  },
  {
    id: 'c5',
    name: '手绘笔记',
    styles: [
      { id: 'c5-sketch', name: 'sketch-notes', useFor: '教培、讲解', risk: '字迹潦草', prompt: 'sketch-notes style, cream paper, black ink lines, pastel marker fills, handwritten arrows and boxes' },
      { id: 'c5-whiteboard', name: '白板', useFor: '会议、课程', risk: '对比度低', prompt: 'whiteboard drawing, marker lines, simple icons, clean white background' },
      { id: 'c5-chalk', name: '黑板粉笔', useFor: '课堂场景', risk: '辨识度略低', prompt: 'chalkboard chalk drawing, dusty texture, white and colored chalk, hand-lettered feel' },
      { id: 'c5-ink', name: '纯墨水线描', useFor: '极简讲解', risk: '无层次', prompt: 'ink line drawing, white background, black strokes, sparse accent color, elegant minimal' }
    ]
  },
  {
    id: 'c6',
    name: '摄影',
    styles: [
      { id: 'c6-editorial', name: '编辑部摄影', useFor: '写实封面', risk: '与图解混搭割裂', prompt: 'editorial photography, clean studio composition, natural light, high detail' },
      { id: 'c6-macro', name: '微距', useFor: '底层细节', risk: '难与宏观同框', prompt: 'macro photography, extreme close-up, shallow depth of field, fine textures' },
      { id: 'c6-product', name: '产品棚拍', useFor: '设备/硬件', risk: '广告味重', prompt: 'product photography, seamless studio background, soft box light, crisp reflections' },
      { id: 'c6-scene', name: '场景虚化', useFor: '真实输入层', risk: '主体不明', prompt: 'realistic photo, natural scene, background bokeh, candid feel' }
    ]
  },
  {
    id: 'c7',
    name: '3D 渲染',
    styles: [
      { id: 'c7-clayscene', name: '软塑场景', useFor: '结构、堆叠、产品', risk: '细节成本高', prompt: '3D clay scene render, soft rounded forms, studio lighting, subtle shadows' },
      { id: 'c7-isoscene', name: '等距场景', useFor: '系统全景', risk: '信息被压缩', prompt: 'isometric 3D scene, miniature diorama, clean lighting, tidy composition' },
      { id: 'c7-glass3d', name: '玻璃 3D', useFor: '未来感叠层', risk: '层界不清', prompt: 'translucent glass 3D render, refraction, soft caustics, layered panels' },
      { id: 'c7-c4d', name: 'C4D 风', useFor: '封面、标题图', risk: '装饰性强', prompt: 'C4D style 3D rendering, glossy shapes, gradient background, playful depth' }
    ]
  },
  {
    id: 'c8',
    name: '平面设计',
    styles: [
      { id: 'c8-memphis', name: '孟菲斯', useFor: '章节页、年轻化', risk: '装饰压过信息', prompt: 'memphis design, bold geometric shapes, squiggles, bright accent colors, playful' },
      { id: 'c8-pop', name: '波普', useFor: '强冲击封面', risk: '不适合正式汇报', prompt: 'pop art style, bold outlines, halftone dots, saturated primary colors' },
      { id: 'c8-collage', name: '拼贴', useFor: '概念混搭', risk: '碎', prompt: 'collage art, cut-paper fragments, mixed textures, layered composition' },
      { id: 'c8-magazine', name: '杂志编辑', useFor: '专题页', risk: '文字量大', prompt: 'editorial magazine layout, strong grid, large typographic blocks, generous white space' },
      { id: 'c8-minimalgeom', name: '极简几何', useFor: '抽象概念', risk: '太抽象', prompt: 'minimal geometric composition, circles and lines, restrained palette, balanced negative space' }
    ]
  },
  {
    id: 'c9',
    name: '未来科技',
    styles: [
      { id: 'c9-hud', name: 'HUD', useFor: 'AI/数据主题', risk: '空、发光干扰', prompt: 'futuristic HUD interface, thin glowing lines, data readouts, dark background' },
      { id: 'c9-hologram', name: '全息', useFor: '概念展示', risk: '透明感弱', prompt: 'holographic projection, translucent cyan light, scanlines, floating layers' },
      { id: 'c9-particles', name: '粒子', useFor: '抽象、连接', risk: '难读', prompt: 'particle network visualization, glowing nodes and links, depth of field' },
      { id: 'c9-wireframe', name: '发光线框', useFor: '结构、模型', risk: '冷硬', prompt: 'glowing wireframe model, neon edges on dark background, technical elegance' },
      { id: 'c9-cyber', name: '赛博', useFor: '强主题', risk: '花哨', prompt: 'cyberpunk aesthetic, neon reflections, dense city-tech atmosphere' }
    ]
  }
]

export const FORMS = [
  { id: 'd1', name: '层级叠层', relation: '上下=层级', direction: 'vertical', prompt: 'stacked layers, bottom to top, clearly separated discrete layers with visible gaps, each layer different content' },
  { id: 'd2', name: '框架图', relation: '并列模块', direction: 'any', prompt: 'framework diagram, parallel modules in equal panels, connected by arrows' },
  { id: 'd3', name: '时间线', relation: '时间先后', direction: 'horizontal', prompt: 'timeline layout, evenly spaced milestones along one axis, progressive stages' },
  { id: 'd4', name: '管道/流程', relation: '输入→输出传递', direction: 'vertical', prompt: 'pipeline diagram flowing upward, each stage passes its output into the next stage as input, short connector arrows between every adjacent pair' },
  { id: 'd5', name: '金字塔/漏斗', relation: '精→粗、少→多', direction: 'vertical', prompt: 'pyramid or funnel layout, narrowing levels from base to top' },
  { id: 'd6', name: '剖面/透视', relation: '内部结构', direction: 'vertical', prompt: 'cutaway cross-section, interior structure visible, layered materials' },
  { id: 'd7', name: '阶梯', relation: '逐级上升', direction: 'vertical', prompt: 'staircase ascending, each step higher than the previous, discrete steps' },
  { id: 'd8', name: '对比条', relation: '左右对照', direction: 'horizontal', prompt: 'side-by-side comparison panels, aligned corresponding items' },
  { id: 'd9', name: '网络/节点图', relation: '连接关系', direction: 'any', prompt: 'network of nodes and links, highlighted paths, layered clusters' },
  { id: 'd10', name: '迭代回环', relation: '循环/迭代', direction: 'cyclic', prompt: 'iterative loop shown as a sequence of discrete stages connected by arrows that return to the start; the loop is expressed by the arrows between stages, NOT by drawing one huge circle' },
  { id: 'd11', name: '隐喻场景', relation: '生活化比喻', direction: 'any', prompt: 'metaphorical scene illustrating the concept through everyday objects' },
  { id: 'd12', name: '矩阵/四象限', relation: '二维分类', direction: 'horizontal', prompt: '2x2 matrix, two axes, items placed in quadrants' },
  { id: 'd13', name: '树状/组织图', relation: '包含与分解', direction: 'vertical', prompt: 'tree diagram, parent node branching into children' },
  { id: 'd14', name: '地图/地理', relation: '空间分布', direction: 'any', prompt: 'map-based layout with pins and regions' },
  { id: 'd15', name: '信息卡组', relation: '并列要点', direction: 'horizontal', prompt: 'row of information cards, equal panels with icon and short caption' },
  { id: 'd16', name: '爆炸图', relation: '部件拆解', direction: 'vertical', prompt: 'exploded view, parts separated along one axis, aligned assembly order' }
]

export const MIX_RULES = [
  { pair: ['d2', 'd3'], name: '框架+时间线', useFor: '上半并列因素、下半阶段演进（商务 PPT 标准打法）' },
  { pair: ['d2', 'c2-clay'], name: '框架+3D IP', useFor: '三栏信息卡 + 卡通 IP 讲解' },
  { pair: ['d1', 'd6'], name: '叠层+剖面', useFor: '立体地层式叠层' },
  { pair: ['d1', 'd4'], name: '叠层+管道', useFor: '既要“层次”又要“逐层传递”（本需求唯一解）' },
  { pair: ['d2', 'd15'], name: '框架+信息卡', useFor: '并列模块带图标说明' }
]

export const RATIOS = [
  { id: '16:9', label: '横 16:9', width: 1344, height: 768, direction: 'horizontal', useFor: 'PPT 满屏' },
  { id: '3:2', label: '横 3:2', width: 1248, height: 832, direction: 'horizontal', useFor: '文档插图' },
  { id: '4:3', label: '横 4:3', width: 1152, height: 864, direction: 'horizontal', useFor: '老版 PPT' },
  { id: '2:1', label: '宽 2:1', width: 1440, height: 720, direction: 'horizontal', useFor: '横幅' },
  { id: '1:1', label: '方 1:1', width: 1024, height: 1024, direction: 'any', useFor: '封面/方图' },
  { id: '3:4', label: '竖 3:4', width: 864, height: 1152, direction: 'vertical', useFor: '海报/竖版长图' },
  { id: '9:16', label: '竖 9:16', width: 720, height: 1280, direction: 'vertical', useFor: 'Story/短视频封面' },
  { id: '5:4', label: '横 5:4', width: 1120, height: 896, direction: 'horizontal', useFor: '图文混排' },
  { id: '4:5', label: '竖 4:5', width: 896, height: 1120, direction: 'vertical', useFor: '社媒竖图' },
  { id: '21:9', label: '横幅 21:9', width: 1680, height: 720, direction: 'horizontal', useFor: '章节页横幅（禁竖向分层）' }
]

export const COMPOSITIONS = [
  { id: 'centered', name: '居中', prompt: 'centered composition, balanced margins' },
  { id: 'thirds', name: '三分', prompt: 'rule-of-thirds composition' },
  { id: 'left-text', name: '左文右图', prompt: 'subject on the right, clean empty space on the left for a title' },
  { id: 'top-bottom', name: '上下分区', prompt: 'top-bottom split layout, clear horizontal division' },
  { id: 'grid', name: '网格对齐', prompt: 'strict grid alignment, equal spacing' },
  { id: 'safe-title', name: '留标题区', prompt: 'generous top margin reserved for a headline, no elements in that band' }
]

export const DENSITIES = [
  { id: 'minimal', name: '极简', prompt: 'minimal composition, at most 5 visual elements, lots of white space' },
  { id: 'medium', name: '中等', prompt: 'moderate information density, 5 to 12 visual elements, clear grouping' },
  { id: 'dense', name: '信息图', prompt: 'rich infographic density, more than 12 elements, still organized in clear sections' }
]

export const TEXT_POLICIES = [
  { id: 'clean-zones', name: '干净留白（框后期代码组装）', prompt: 'keep clean empty areas around the main elements for labels to be added later; do NOT draw any text boxes, frames, speech bubbles or letters' },
  { id: 'reserve-boxes', name: '留空文字框（旧策略）', prompt: 'leave 3-6 EMPTY rounded label boxes or speech bubbles with no letters inside, positioned away from the subject; no text, no letters anywhere' },
  { id: 'none', name: '无文字', prompt: 'no text, no labels, no captions, no letters anywhere' },
  { id: 'reserve-boxes', name: '留空文字框（SKILL H）', prompt: 'no text rendered at all; reserve 4-8 empty rounded label boxes or callouts with blank interiors at logical positions, for captions to be added later in PPT/PS with a regular sans-serif font' },
  { id: 'diagram-labels', name: '图解标签（参考图风格）', prompt: '5-10 short Chinese labels inside rounded text boxes or callouts, each 2-6 characters, hand-written look, placed right next to the element they describe; no other text' },
  { id: 'few-labels', name: '少量短标签', prompt: 'at most 4 short labels of 2-4 Chinese characters each, placed at fixed positions, no long sentences' },
  { id: 'exact', name: '精确字串', prompt: 'render only the exact quoted Chinese strings provided, each at a specified position, no other text' }
]

export const PALETTES = [
  { id: 'blue-violet-cyan', name: '蓝紫青+橙', prompt: 'blue, violet and cyan primary palette with one orange accent for focus' },
  { id: 'warm-dark', name: '暖黄+深灰', prompt: 'warm yellow highlights on a deep charcoal background, cozy lamp light' },
  { id: 'mono-accent', name: '单色+强调', prompt: 'grayscale base with one saturated accent color' },
  { id: 'pastel', name: '马卡龙浅色', prompt: 'soft pastel palette, low contrast, airy background' },
  { id: 'dark-neon', name: '暗色霓虹', prompt: 'dark background with cyan and magenta neon accents' },
  { id: 'paper', name: '纸张自然色', prompt: 'natural paper tones, warm off-white background, muted earth palette' }
]

export const NEGATIVE_DEFAULT = 'no text unless specified, no gibberish characters, no watermark, no signature, no extra limbs, no distorted anatomy, no cluttered composition, no single long arrow spanning from bottom to top, no duplicated layer content, no furniture, no lamps, no books, no unrelated props in the feature layers'

const STYLE_INDEX = new Map()
for (const family of STYLE_FAMILIES) {
  for (const style of family.styles) STYLE_INDEX.set(style.id, { ...style, family: family.name, familyId: family.id })
}
const FORM_INDEX = new Map(FORMS.map((form) => [form.id, form]))
const RATIO_INDEX = new Map(RATIOS.map((ratio) => [ratio.id, ratio]))

export function listCatalog() {
  const skill = loadSkill()
  return {
    styles: [...STYLE_INDEX.values()].map((style) => ({ id: style.id, name: style.name, family: style.family, familyId: style.familyId, useFor: style.useFor, risk: style.risk })),
    forms: FORMS.map((form) => ({ id: form.id, name: form.name, relation: form.relation, direction: form.direction })),
    ratios: RATIOS.map((ratio) => ({ id: ratio.id, label: ratio.label, useFor: ratio.useFor })),
    compositions: COMPOSITIONS.map((item) => ({ id: item.id, name: item.name })),
    densities: DENSITIES.map((item) => ({ id: item.id, name: item.name })),
    textPolicies: TEXT_POLICIES.map((item) => ({ id: item.id, name: item.name })),
    palettes: PALETTES.map((item) => ({ id: item.id, name: item.name })),
    mixRules: MIX_RULES,
    promptFlow: skill.promptFlow || [],
    textRules: skill.textRules || {},
    appendixCount: skill.appendixCount || 0,
    references: (skill.references || []).map((ref) => ({ id: ref.id, name: ref.name, annotation: ref.annotation }))
  }
}

/** 语义启发式：从一句话里找 LOCK 线索与歧义词 */
export function analyzeBrief(brief) {
  const text = String(brief || '')
  const direction = (() => {
    if (/环形|循环|反馈回路/.test(text)) return 'cyclic'
    if (/时间轴|时间线|阶段|演进|历史/.test(text)) return 'timeline'
    if (/往上|向上|自下而上|从下到上|一层层|逐层|层层/.test(text)) return 'vertical-up'
    if (/往下|向下|自上而下|从上到下/.test(text)) return 'vertical-down'
    if (/横向|左右|并列|对比|并排/.test(text)) return 'horizontal'
    return ''
  })()
  const hasTransfer = /(上一[层级步阶段个])[^。；;]{0,20}(输出|结果|特征)[^。；;]{0,20}(输入|作为)/.test(text) || /逐层(传递|输入)|拿上一层的/.test(text)
  const layerMatch = text.match(/([三四五六七八九十\d]+)\s*层/)
  const layerCount = layerMatch ? (Number(layerMatch[1]) || 0) : 0
  const locks = []
  if (direction) locks.push({ type: 'direction', value: direction, evidence: '方位/顺序词' })
  if (hasTransfer) locks.push({ type: 'transfer', value: 'layer-to-layer', evidence: '传递/输入输出描述' })
  if (layerCount) locks.push({ type: 'count', value: layerCount, evidence: '数量词' })
  if (/仅作科普|不要公式|无数据|不要数字/.test(text)) locks.push({ type: 'negative', value: 'no formulas/data', evidence: '限制词' })
  if (/[「《"].+?[」》"]/.test(text)) locks.push({ type: 'text', value: 'exact-strings', evidence: '引号内精确文字' })
  const ambiguities = []
  for (const term of ['抽象', '科普', '生动', '简洁', '智能', '学习', '模型', '整体判断', '底层', '高层']) {
    if (text.includes(term)) ambiguities.push(term)
  }
  const notes = []
  if (hasTransfer) notes.push('检测到「上一层输出→下一层输入」类传递关系：必须画层间短箭头 + 元素跨层延续，禁止贯穿大箭头。')
  if (direction === 'vertical-up') notes.push('检测到纵向递进：画幅不能用 21:9，建议 3:4 / 9:16 / 1:1 / 4:3。')
  if (direction === 'horizontal') notes.push('检测到并列/左右关系：优先横版 16:9 / 3:2，用对比或框架图。')
  if (!direction) notes.push('原文没有明确方向词：按「因果→纵向、并列→横向、时间→时间线」的规则推断，或横竖各出一版。')
  const interpretable = detectInterpretations(text)
  const steps = detectSteps(text)
  if (interpretable.length) {
    notes.push(`可释义发散（不是强制物体）：${interpretable.map((entry) => entry.matched.join('/')).join('、')}——按关系表达，禁止字面符号化。`)
  }
  if (steps.length >= 2) notes.push(`检测到流程动词：${steps.join(' → ')}——按步骤链路表达，循环词用返回箭头而不是大圆。`)
  return {
    briefText: text,
    direction,
    hasTransfer,
    layerCount,
    locks,
    ambiguities,
    interpretable,
    steps,
    textNeeded: /[「《"].+?[」》"]/.test(text),
    notes
  }
}

/**
 * 可释义词库：这些词是**关系/隐喻**，不是物体要求。
 * 字面陷阱 = 模型最容易被带偏的单一符号；rule = 用元素+箭头把关系画出来的写法。
 */
export const AMBIGUOUS_LEXICON = [
  {
    terms: ['循环', '闭环', '迭代', '反复', '回环', '往复'],
    kind: 'loop',
    relation: 'steps that return to the start',
    trap: 'a single empty circle (or gear) as the whole image',
    options: ['编号步骤首尾用箭头相连', '队列逐项处理并把结果回填到前文', '阶段性迭代，带一条返回起点的箭头'],
    rule: '循环 is a RELATION: draw 3-5 discrete steps with forward arrows and one return arrow; NEVER make a big circle the whole picture.'
  },
  {
    terms: ['抽象', '压缩', '特征', '语义'],
    kind: 'abstraction',
    relation: 'details fading while meaning is kept',
    trap: 'a vague blur or a random geometric shape',
    options: ['颗粒由细到粗、细节递减但主体可辨', '实拍→剪影→图标的符号化过程'],
    rule: '抽象 must be shown as a sequence whose detail decreases while the recognizable subject stays readable.'
  },
  {
    terms: ['智能', '思考', '推理', '决策', '策略', '选取', '选择', '判断'],
    kind: 'cognition',
    relation: 'multi-step process with a decision point',
    trap: 'one brain icon or a lightbulb',
    options: ['多个候选项进入比较，一个被选中', '分支判断后汇合', '从信息到结论的箭头链'],
    rule: '认知类概念 must be shown as a process with inputs, a comparison/decision, and an output; not a single brain or bulb icon.'
  },
  {
    terms: ['流动', '传递', '输入', '输出', '管道', '接上', '接到', '接到前文'],
    kind: 'flow',
    relation: 'hand-off from one stage to the next',
    trap: 'literal water pipes or conveyor belts',
    options: ['元素交给下一环节的接力', '带接口的层级传递'],
    rule: '流动/传递 must be shown by hand-off arrows between elements; pipes are optional, the hand-off is mandatory.'
  },
  {
    terms: ['网络', '连接', '生态', '关联'],
    kind: 'network',
    relation: 'nodes with meaningful links',
    trap: 'decorative spiderweb or rings of dots',
    options: ['有意义的节点与连线（每条线都有含义）', '多层节点带层级'],
    rule: '网络 must have meaningful links; avoid decorative webs with no semantics.'
  },
  {
    terms: ['树', '层级', '金字塔', '分解'],
    kind: 'hierarchy',
    relation: 'parent-child decomposition',
    trap: 'a literal tree or pyramid filling the canvas',
    options: ['自上而下分支', '包含关系用嵌套区块'],
    rule: '层级/树 must show parent-child structure with labels; a literal tree shape is optional, the decomposition is mandatory.'
  },
  {
    terms: ['记忆', '存储', '缓存', '历史'],
    kind: 'memory',
    relation: 'store then retrieve',
    trap: 'a hard-disk or USB-stick icon',
    options: ['历史内容堆叠并被取回', '左右两条箭头：写入与读取'],
    rule: '记忆/存储 must show write and read arrows, not just a disk icon.'
  },
  {
    terms: ['生成', '创造', '涌现', '产生'],
    kind: 'generation',
    relation: 'input transformed into new output',
    trap: 'a lightbulb or sparkles alone',
    options: ['输入→变换→新结果', '多个候选结果生成后挑选'],
    rule: '生成 must show input, transformation and the produced result.'
  },
  {
    terms: ['反馈', '校正', '修正', '评估'],
    kind: 'feedback',
    relation: 'compare output with the goal and correct',
    trap: 'a circular arrow going nowhere',
    options: ['输出与目标对比，差异箭头回指', '打勾/叉的评估节点'],
    rule: '反馈 must show output compared against a target, with the difference feeding back.'
  }
]

function detectInterpretations(text) {
  const source = String(text || '')
  const found = []
  for (const entry of AMBIGUOUS_LEXICON) {
    const matched = entry.terms.filter((term) => source.includes(term))
    if (matched.length) found.push({ ...entry, matched })
  }
  return found
}

const PROCESS_VERBS = ['读取', '获取', '计算', '选取', '选择', '拼接', '接到', '接上', '更新', '判断', '生成', '输出', '回填', '继续', '循环', '直到完成', '完成']
function detectSteps(text) {
  const source = String(text || '')
  const hits = []
  for (const verb of PROCESS_VERBS) {
    const index = source.indexOf(verb)
    if (index !== -1) hits.push({ verb, index })
  }
  return hits.sort((a, b) => a.index - b.index).map((hit) => hit.verb).slice(0, 6)
}

/** 按 SKILL B 节推断主体类型/数量/文字框位置（静态启发式，Agent 可覆盖） */
export function inferSubject(brief, analysis) {
  const text = String(brief || '')
  const isIp = /机器人|助手|学徒|角色|拟人|小动物|人物/.test(text) || (analysis && analysis.ambiguities && analysis.ambiguities.includes('智能'))
  const isReal = /照片|实拍|真实|摄影|画布|调色盘|纸张|手绘材料/.test(text)
  const type = isIp ? 'IP 拟人主体（机器人/学徒/小动物，只服务语义不抢戏）' : isReal ? '真实对象主体（画布/纸张/素材/道具，服务信息不做装饰）' : '纯图形主体（几何体/图标/层块/箭头，不拟人）'
  const countMatch = text.match(/([一二三四五六七八九十\d]+)\s*(个|层|种|只|张|位|步)/)
  const count = countMatch ? countMatch[1] + countMatch[2] : '按需求数量，不放未要求的重复主体'
  const textBoxes = /层|阶梯|金字塔/.test(text)
    ? ['每层右侧各留 1 个空白短标签框', '顶部留 1 个空白标题框']
    : ['左上角留 1 个空白标题框', '主体旁留 2-3 个空白短标签框']
  return { type, count, textBoxes }
}

/** 七要素提示词模板（对应 SKILL「提示词生成流程」：主体/细节/环境/风格/构图/光照/画质+负面） */
function buildSevenElementsPrompt(fields) {
  const lines = []
  lines.push('Subject: ' + fields.subject)
  lines.push('Details & attributes: ' + fields.details)
  lines.push('Environment & scene: ' + fields.environment)
  lines.push('Art style & medium: ' + fields.style)
  lines.push('Composition & camera: ' + fields.composition)
  lines.push('Lighting & color: ' + fields.lighting)
  lines.push('Empty text boxes: ' + fields.textBoxes)
  lines.push('Quality: crisp hand-drawn lines, clean layout, coherent palette, high detail')
  lines.push('Negative: ' + fields.negative)
  return lines.join('\n')
}

function pickIds(list, fallbackIds, limit) {
  const ids = Array.isArray(list) && list.length ? list.filter((id) => STYLE_INDEX.has(id) || FORM_INDEX.has(id) || RATIO_INDEX.has(id)) : []
  const chosen = ids.length ? ids : fallbackIds
  return chosen.slice(0, limit)
}

function defaultStyles(analysis) {
  if (/艺术|美术|学生|讲义|科普/.test(analysis.briefText || '')) return ['c4-artlecture', 'c2-picturebook', 'c5-sketch', 'c1-flat']
  if (analysis.direction === 'vertical-up' || analysis.hasTransfer) {
    return ['c2-clay', 'c1-glass', 'c2-picturebook', 'c1-flat']
  }
  if (/艺术|美术|学生|讲义|科普/.test(analysis.briefText || '')) return ['c4-artlecture', 'c2-picturebook', 'c5-sketch', 'c1-flat']
  if (analysis.ambiguities.includes('科普')) return ['c2-picturebook', 'c2-clay', 'c1-flat', 'c5-sketch']
  return ['c1-flat', 'c1-glass', 'c2-clay']
}

function defaultForms(analysis) {
  if (analysis.hasTransfer) return ['d4', 'd1', 'd7', 'd6']
  if (analysis.direction === 'vertical-up') return ['d1', 'd7', 'd5', 'd6']
  if (analysis.direction === 'timeline') return ['d3', 'd2', 'd15']
  if (analysis.direction === 'horizontal') return ['d2', 'd8', 'd15']
  if (analysis.direction === 'cyclic') return ['d10', 'd9']
  return ['d2', 'd15', 'd1']
}

function defaultRatios(analysis) {
  if (analysis.direction === 'vertical-up' || analysis.direction === 'vertical-down') return ['3:4', '1:1', '16:9']
  if (analysis.direction === 'timeline') return ['16:9', '2:1', '1:1']
  return ['16:9', '1:1', '3:4']
}

export const MAX_VARIANTS = 8

/**
 * 组装变体提示词。
 * 释义版本数由 SKILL 策略驱动（语义维 2–3 种解读），默认取策略上限。
 * @param {object} options
 * @param {string} options.brief 用户原话
 * @param {string[]} [options.mustKeep] 额外硬约束（Agent 提炼）
 * @param {string[]} [options.styles] 风格 id 列表
 * @param {string[]} [options.forms] 图型 id 列表
 * @param {string[]} [options.ratios] 比例 id 列表
 * @param {number} [options.count=6] 释义版本数：最少 6，最多 8
 * @param {string} [options.density]
 * @param {string} [options.textPolicy]
 * @param {string} [options.palette]
 * @param {string} [options.composition]
 * @param {string} [options.negative]
 * @param {string[]} [options.interpretations] 自定义释义说明（不传则用可释义词库自动展开）
 * @param {string} [options.language='en'] prompt 主语言
 */
export function composePrompts(options = {}) {
  const brief = String(options.brief || '').trim()
  if (!brief) throw new Error('缺少 brief（用户需求原话）')
  const analysis = analyzeBrief(options.mustKeep && options.mustKeep.length ? `${brief} ${options.mustKeep.join(' ')}` : brief)
  const skill = options.skill || loadSkill()
  const limit = Math.min(MAX_VARIANTS, Math.max(1, Number(options.count) || skill.strategy.semanticMax || 3))
  const styleIds = pickIds(options.styles, defaultStyles(analysis), 4)
  const formIds = pickIds(options.forms, defaultForms(analysis), 4)
  const ratioIds = pickIds(options.ratios, defaultRatios(analysis), 3)
  // 保证「风格 × 图型」组合数 ≥ 释义版本数（不够就用默认池补齐）
  const pairs = []
  for (const styleId of styleIds) {
    for (const formId of formIds) pairs.push({ styleId, formId })
  }
  if (pairs.length < limit) {
    const extraForms = [...formIds]
    for (const fallback of [...defaultForms(analysis), 'd11', 'd15', 'd2']) {
      if (!extraForms.includes(fallback)) extraForms.push(fallback)
    }
    for (const styleId of styleIds) {
      for (const formId of extraForms) {
        if (pairs.length >= limit) break
        if (!pairs.some((pair) => pair.styleId === styleId && pair.formId === formId)) pairs.push({ styleId, formId })
      }
    }
  }
  // 释义池：优先用调用方给的，否则从可释义词库里展开（循环/策略/历史… 每个词 2–3 种表达）
  const interpretationPool = Array.isArray(options.interpretations) && options.interpretations.filter(Boolean).length
    ? options.interpretations.filter(Boolean)
    : analysis.interpretable.flatMap((entry) => entry.options.map((option) => `${entry.matched[0]}：${option}`))
  const density = DENSITIES.find((item) => item.id === options.density) || DENSITIES[1]
  const textPolicy = TEXT_POLICIES.find((item) => item.id === options.textPolicy) || TEXT_POLICIES.find((item) => item.id === 'clean-zones') || TEXT_POLICIES[0]
  const palette = PALETTES.find((item) => item.id === options.palette) || PALETTES[0]
  const composition = COMPOSITIONS.find((item) => item.id === options.composition) || COMPOSITIONS[0]
  const negative = String(options.negative || '')
  const extra = Array.isArray(options.interpretations) ? options.interpretations.filter(Boolean) : []
  const skillBlock = skillPromptBlock(skill)
  const references = matchReferences(brief, skill.references || [], 2)
  const refBlock = referenceBlock(references)
  const constraintSet = buildConstraints({
    brief,
    analysis,
    mustKeep: options.mustKeep,
    textPolicy: textPolicy.id,
    skillBlock,
    referenceBlock: refBlock
  })
  const constraintBlock = renderConstraintBlock(constraintSet.constraints)
  const negativeText = renderNegative(negative, constraintSet.negatives)
  const checks = buildChecklist(constraintSet.constraints)

  const variants = []
  // SKILL 铁律 3：风格 Top-k 必须来自**不同风格分类**（默认 4 个分类）
  const categoriesTarget = Math.max(4, skill.strategy.styleCategoriesMin || 4)
  const stylesByFamily = []
  const usedFamilies = new Set()
  for (const id of [...styleIds, ...defaultStyles(analysis), ...STYLE_INDEX.keys()]) {
    if (stylesByFamily.length >= categoriesTarget) break
    const style = STYLE_INDEX.get(id)
    if (!style || usedFamilies.has(style.familyId)) continue
    usedFamilies.add(style.familyId)
    stylesByFamily.push(id)
  }
  const uniqueStyleIds = stylesByFamily
  // 每个释义版本铺 ≥4 种风格（跨分类）
  const stylesPerVersion = Math.max(4, skill.strategy.stylesMin || 4)
  for (let version = 0; version < limit; version += 1) {
    const interpretation = interpretationPool.length ? interpretationPool[version % interpretationPool.length] : ''
    for (let styleIndex = 0; styleIndex < stylesPerVersion; styleIndex += 1) {
      const style = STYLE_INDEX.get(uniqueStyleIds[styleIndex % uniqueStyleIds.length])
      const form = FORM_INDEX.get(formIds[(version + styleIndex) % formIds.length])
      if (!style || !form) continue
      let ratio = null
      for (let step = 0; step < ratioIds.length; step += 1) {
        const candidate = RATIO_INDEX.get(ratioIds[(version + styleIndex + step) % ratioIds.length])
        if (!candidate) continue
        if (form.direction === 'vertical' && candidate.id === '21:9') continue
        ratio = candidate
        break
      }
      if (!ratio) continue
      // 按新版 SKILL「七要素」组织画面正文；约束/参考图说明只作校验元数据
      const subject = inferSubject(brief, analysis)
      const scene = interpretation ? `${brief}（${interpretation}）` : brief
      const prompt = buildSevenElementsPrompt({
        subject: `${subject.type}；数量：${subject.count}；核心对象：${scene}`,
        details: `保留主谓宾与背景：${scene}；合理补充输入/输出等细节；关键名词只留空白框、不依赖模型渲染长文字`,
        environment: 'clean cream or white paper background, generous white space, no busy scenery',
        style: `${style.prompt}; ${referenceStyleKeywords()}`,
        composition: `${form.prompt}; ${composition.prompt}; ratio ${ratio.id}`,
        lighting: `${palette.prompt}; ${density.prompt}; soft even lighting`,
        textBoxes: `${textPolicy.prompt}；${subject.textBoxes.join('；')}；框内不出现文字`,
        negative: negativeText
      })

      const interpretationTag = interpretation ? `释义${version + 1}｜` : ''
      variants.push({
        label: `${interpretationTag}${style.name} × ${form.name} · ${ratio.label}`,
        version: version + 1,
        interpretation,
        styleId: style.id,
        styleFamily: style.family,
        formId: form.id,
        ratio: ratio.id,
        references: references.map((ref) => ({ id: ref.id, annotation: ref.annotation })),
        prompt,
        negative: negativeText,
        spec: {
          constraints: constraintSet.constraints.map((constraint) => `[${constraint.id}] ${constraint.verify}`),
          checks,
          references: references.map((ref) => ({ annotation: ref.annotation, hasBase: Boolean(ref.basePath), hasText: Boolean(ref.textPath) })),
          textRules: skill.textRules,
          promptFlow: skill.promptFlow,
          textAssets: references.filter((ref) => ref.textPath).map((ref) => ref.textPath)
        },
        validation: { ok: true, missing: [] },
        note: `${style.useFor ? `适合：${style.useFor}；` : ''}${style.risk ? `风险：${style.risk}` : ''}`
      })
    }
  }
  if (!variants.length) throw new Error('没有组出任何提示词：检查 styles/forms 参数与 SKILL 配置')
  return {
    brief,
    analysis,
    stages: inferStages(brief),
    interpretations: interpretationPool,
    skill: {
      path: skill.path || '',
      title: skill.title,
      angles: skill.angles.length,
      stylesMin: skill.strategy.stylesMin,
      promptFlow: (skill.promptFlow || []).length,
      textSeparated: Boolean(skill.textRules && skill.textRules.separate),
      appendixCount: skill.appendixCount || 0,
      styleCategoriesMin: skill.strategy.styleCategoriesMin,
      referenceCount: (skill.references || []).length
    },
    references: references.map((ref) => ({ id: ref.id, name: ref.name, annotation: ref.annotation })),
    versions: limit,
    stylesPerVersion,
    totalImages: variants.length,
    constraints: constraintSet.constraints.map((constraint) => ({
      id: constraint.id,
      type: constraint.type,
      text: constraint.text,
      verify: constraint.verify
    })),
    checks,
    variants,
    notes: analysis.notes
  }
}

export { STYLE_INDEX, FORM_INDEX, RATIO_INDEX }
