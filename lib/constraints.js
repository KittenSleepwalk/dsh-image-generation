/**
 * 提示词约束引擎（v2.1）
 *
 * 问题：提示词写成长篇散文时，模型会把「各一根」理解成「每层三根」、把「底层」槽位用台灯/书桌填满。
 * 做法：把「不能错的部分」编译成**带编号、带数量、带位置、带禁止项、带验收问题**的约束对象，
 *       再渲染成结构化提示词块（编号 + ONLY/EXACTLY/NEVER 句式 + 统一负面词），并附带校验清单与修复块。
 *
 * 纯静态逻辑，可离线单测。
 */

export const NEGATIVE_LIBRARY = {
  structure: 'no overlapping layers, no merged stages, no duplicated content across stages',
  arrow: 'no arrow spanning more than one gap, no more than one arrow per gap, no arrow inside a stage',
  props: 'no furniture, no lamps, no books, no plants, no decorative props in any stage',
  objects: 'no complete objects before the final stage',
  text: 'no gibberish characters, no long sentences, no vertical label columns',
  math: 'no formulas, no equations, no charts, no axes, no percentages',
  quality: 'no watermark, no signature, no extra limbs, no distorted anatomy, no cluttered composition'
}

const NUMBER_WORDS = { 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight' }

function wordFor(value) {
  return NUMBER_WORDS[value] || String(value)
}

/**
 * 从一句话里推断「分层内容白名单」。命中「底层/中层/上层」这类描述时，
 * 自动生成 4 层（像素/边缘 → 轮廓/部件 → 组装中 → 完整对象+判断）的可执行清单。
 */
export function inferStages(brief) {
  const text = String(brief || '')
  const mentionsBottom = /底层|靠下的层|下层|最底层/.test(text)
  const mentionsMiddle = /中间层|中层/.test(text)
  const mentionsTop = /上层|顶层|高层/.test(text)
  const mentionsDetail = /边缘|明暗|像素|纹理|细节/.test(text)
  const mentionsParts = /轮廓|部件|拼成|拼合/.test(text)
  const mentionsWhole = /猫|车|狗|人|完整|整体判断|这是一只/.test(text)
  if (!(mentionsBottom || mentionsMiddle || mentionsTop)) return []
  const stages = []
  stages.push({
    name: '底层（输入细节）',
    allow: 'a horizontal BAND that is EMPTY except gray pixel noise and soft light-dark patches; nothing is recognizable here',
    deny: 'no outlines, no objects, no furniture, no props, no lamps, no books'
  })
  if (mentionsParts) {
    stages.push({
      name: '中层（轮廓与部件）',
      allow: 'a horizontal BAND containing ONLY thin black outlines and detached line fragments (ears, eyes, wheels, windows) floating apart, semi-transparent',
      deny: 'no complete objects, no solid color, no judgement labels'
    })
  }
  stages.push({
    name: '中上层（组合中）',
    allow: 'a horizontal BAND with outlines joining into partial cat and car shapes, still semi-transparent and incomplete',
    deny: 'no finished scene, no solid fill, no judgement labels'
  })
  if (mentionsWhole) {
    stages.push({
      name: '顶层（完整对象+判断）',
      allow: 'a horizontal BAND with ONE complete cat and ONE complete car, solid color, clearly readable',
      deny: 'no fragments, no outlines-only, no raw pixels'
    })
  }
  return stages
}

/** 生成约束集合：[{id,type,text,verify,negative,severity}] */
export function buildConstraints(options = {}) {
  const brief = String(options.brief || '')
  const analysis = options.analysis || {}
  const mustKeep = Array.isArray(options.mustKeep) ? options.mustKeep.filter(Boolean) : []
  const stages = Array.isArray(options.stages) && options.stages.length ? options.stages : inferStages(brief)
  const constraints = []
  const layerCount = analysis.layerCount || (stages.length ? stages.length : 0)
  const negatives = new Set()

  if (analysis.direction === 'vertical-up' || analysis.direction === 'vertical-down') {
    const count = layerCount || 4
    constraints.push({
      id: 'C1',
      type: 'direction',
      severity: 'hard',
      text: `EXACTLY ${count} (${wordFor(count)}) horizontal BANDS stacked VERTICALLY ${analysis.direction === 'vertical-up' ? 'from bottom to top' : 'from top to bottom'}, equal spacing, bands DO NOT overlap.`,
      verify: `层数=${count}、${analysis.direction === 'vertical-up' ? '自下而上' : '自上而下'}、层与层不重叠`,
      negative: 'structure'
    })
    negatives.add('structure')
  }

  if (analysis.hasTransfer) {
    const gaps = Math.max(1, (layerCount || 4) - 1)
    constraints.push({
      id: 'C2',
      type: 'transfer',
      severity: 'hard',
      text: `EXACTLY ${gaps} (${wordFor(gaps)}) short upward arrows IN TOTAL: one single arrow centered in each gap between adjacent layers. NEVER more than one arrow per gap, NEVER one arrow spanning two or more gaps, NEVER arrows inside a layer. Each layer visibly receives the previous layer's items: the same shapes continue upward and are built upon.`,
      verify: `箭头总数=${gaps}、每层间 1 根、无贯穿大箭头、上一层元素在下一层可见延续`,
      negative: 'arrow'
    })
    negatives.add('arrow')
  }

  if (stages.length) {
    const lines = stages.map(
      (stage, index) => `BAND ${index + 1} (from bottom) — ${stage.name}: ${stage.allow}; ${stage.deny}.`
    )
    constraints.push({
      id: 'C3',
      type: 'inventory',
      severity: 'hard',
      text: `Each BAND contains STRICTLY DIFFERENT content, whitelisted as follows:\n${lines.join('\n')}`,
      verify: `每一层内容与白名单一致、层间不重复（${stages.map((stage) => stage.name).join(' / ')}）`,
      negative: 'props'
    })
    negatives.add('props')
    negatives.add('objects')
  }

  // 可释义发散：这些词是关系/隐喻，禁止字面符号化
  if (Array.isArray(analysis.interpretable) && analysis.interpretable.length) {
    const lines = analysis.interpretable.map((entry) => `- ${entry.matched.join('/')}: ${entry.rule}`)
    constraints.push({
      id: `C${constraints.length + 1}`,
      type: 'interpretation',
      severity: 'hard',
      text: `These words describe RELATIONS, not objects — do NOT literalize them as one symbol:\n${lines.join('\n')}\nThe meaning must be carried by at least 3 discrete elements connected by arrows.`,
      verify: `这些词按关系表达（${analysis.interpretable.map((entry) => entry.matched[0]).join('、')}），没有用单一符号代替整图`,
      negative: ''
    })
  }

  // 流程动词：按步骤链路画，循环用返回箭头而不是大圆
  if (Array.isArray(analysis.steps) && analysis.steps.length >= 2) {
    const steps = analysis.steps
    constraints.push({
      id: `C${constraints.length + 1}`,
      type: 'process',
      severity: 'hard',
      text: `Show the process as ${steps.length} ordered steps: ${steps.join(' → ')}. Each step is a distinct element with an arrow to the next; the LAST step connects back to the FIRST with a visible return arrow. The loop is made of arrows between the steps — NEVER one huge circle as the whole image.`,
      verify: `按顺序画出 ${steps.length} 个步骤（${steps.join('→')}），步骤间有箭头，末步以返回箭头接回首步，整图不是一个大圆`,
      negative: ''
    })
  }

  if (mustKeep.length > 2) {
    // 约束预算：额外硬约束超过 2 条时合并，避免提示词过长被稀释
    constraints.push({
      id: `C${constraints.length + 1}`,
      type: 'must-keep',
      severity: 'hard',
      text: `ALSO REQUIRED: ${mustKeep.join('; ')}`,
      verify: mustKeep.join('；'),
      negative: ''
    })
    if (mustKeep.some((item) => /公式|坐标轴|百分比|数据/.test(String(item)))) negatives.add('math')
  } else {
    mustKeep.forEach((item) => {
      constraints.push({
        id: `C${constraints.length + 1}`,
        type: 'must-keep',
        severity: 'hard',
        text: String(item).trim(),
        verify: String(item).trim(),
        negative: ''
      })
      if (/公式|坐标轴|百分比|数据/.test(String(item))) negatives.add('math')
    })
  }

  if (options.textPolicy === 'none') {
    constraints.push({
      id: `C${constraints.length + 1}`,
      type: 'text',
      severity: 'hard',
      text: 'NO text anywhere: no letters, no labels, no captions.',
      verify: '画面无任何文字/字母',
      negative: 'text'
    })
    negatives.add('text')
  } else if (options.textPolicy === 'reserve-boxes') {
    constraints.push({
      id: `C${constraints.length + 1}`,
      type: 'text',
      severity: 'hard',
      text: 'TEXT/IMAGE SEPARATION: reserve 3-6 EMPTY text boxes or speech bubbles with NO letters inside (text will be added later in PPT/PS); never render Chinese or English text.',
      verify: '留出空白文字框/气泡框且框内无字（文字后期加）',
      negative: 'text'
    })
    negatives.add('text')
  } else if (options.textPolicy === 'few-labels') {
    constraints.push({
      id: `C${constraints.length + 1}`,
      type: 'text',
      severity: 'hard',
      text: 'AT MOST 4 short labels, each 2-4 Chinese characters, each placed at a fixed named position; NO other text, NO sentences.',
      verify: '标签≤4 处、每处≤4 字、位置固定、无其他文字',
      negative: 'text'
    })
    negatives.add('text')
  }

  if (analysis.locks && analysis.locks.some((lock) => lock.type === 'negative')) {
    constraints.push({
      id: `C${constraints.length + 1}`,
      type: 'content-ban',
      severity: 'hard',
      text: 'This illustration is for general-audience science communication ONLY: NO formulas, NO equations, NO charts, NO axes, NO percentages, NO dataset screenshots.',
      verify: '无公式/坐标轴/图表/百分比',
      negative: 'math'
    })
    negatives.add('math')
  }

  negatives.add('quality')
  // SKILL 规则块：人工 SKILL 里的铁律原样进入每条提示词，保证口径不漂移
  if (options.skillBlock) {
    constraints.push({
      id: `C${constraints.length + 1}`,
      type: 'skill',
      severity: 'hard',
      text: String(options.skillBlock),
      verify: '具象语义固定、抽象语义拟人化发散、关键名词用文字框/气泡框标注',
      negative: ''
    })
  }
  // 参考图视觉语言：按参考图风格画，不照抄内容
  if (options.referenceBlock) {
    constraints.push({
      id: `C${constraints.length + 1}`,
      type: 'reference',
      severity: 'hard',
      text: String(options.referenceBlock),
      verify: '视觉语言与参考图一致（手绘马克笔信息图/矢量分层、中文标签框、分层色带、细箭头、留白），不照抄参考图内容',
      negative: ''
    })
  }
  // 收口约束：cfg=1 时负面提示词分支不参与计算，因此用正向“画面里只有这些”来替代负面词
  constraints.push({
    id: `C${constraints.length + 1}`,
    type: 'closed-world',
    severity: 'hard',
    text: stages.length
      ? 'The image contains ONLY the bands described above and their arrows. Nothing else is drawn: no other objects, no furniture, no plants, no text or labels unless a text policy allowed them.'
      : 'The image contains ONLY the elements and arrows described above. Nothing else is drawn: no other objects, no furniture, no plants, no text or labels unless a text policy allowed them.',
    verify: '画面只有列出的条带与箭头，无其他物体/文字',
    negative: 'props'
  })
  return { constraints, negatives: [...negatives].map((key) => NEGATIVE_LIBRARY[key]).filter(Boolean) }
}

/** 渲染成编号约束块（放在提示词最前面，模型对开头/结尾最敏感） */
export function renderConstraintBlock(constraints) {
  if (!constraints.length) return ''
  const lines = constraints.map((constraint) => `[${constraint.id}] ${constraint.text}`)
  return `MUST-FOLLOW CONSTRAINTS (numbered, each verifiable):\n${lines.join('\n')}`
}

/** 渲染统一负面词 */
export function renderNegative(extraNegatives, libraryNegatives) {
  const parts = []
  if (extraNegatives) parts.push(String(extraNegatives))
  parts.push(...(libraryNegatives || []))
  return parts.filter(Boolean).join(', ')
}

/** 生成交付前的逐条验收清单（给 Agent 用 read_image 核对） */
export function buildChecklist(constraints) {
  return constraints.map((constraint) => ({ id: constraint.id, type: constraint.type, check: constraint.verify }))
}

/** 生成「修复块」：上一轮哪条没过，就把失败项写成显式纠正句重新出图 */
export function buildRepairBlock(failedIds, constraints) {
  const failed = constraints.filter((constraint) => failedIds.includes(constraint.id))
  if (!failed.length) return ''
  const lines = failed.map(
    (constraint) =>
      `FIX [${constraint.id}]: the previous attempt failed this rule — ${constraint.verify}. Redraw so that it is unmistakably true; remove whatever violated it.`
  )
  return `CORRECTIONS from previous attempt:\n${lines.join('\n')}`
}

/** 出图前的静态自检：约束块是否完整、是否每条都有可验收证据 */
export function validatePrompt(prompt, constraints) {
  const text = String(prompt || '')
  const missing = []
  for (const constraint of constraints) {
    if (!text.includes(`[${constraint.id}]`)) missing.push(`${constraint.id} 未写入提示词`)
    if (!constraint.verify) missing.push(`${constraint.id} 缺少验收标准`)
  }
  if (constraints.some((constraint) => constraint.type === 'transfer') && !/EXACTLY \d+/.test(text)) {
    missing.push('传递关系缺少精确数量（EXACTLY N arrows）')
  }
  return { ok: missing.length === 0, missing }
}
