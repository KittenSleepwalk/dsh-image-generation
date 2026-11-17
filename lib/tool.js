/** 对外工具契约：唯一工具 generate_image（可配置名），参数只暴露 Agent 需要理解的东西。 */

import { resolveConfig, CONFIG_DIR, ensureDir } from './config.js'
import { PRESET_NAMES, ASPECTS_1MP } from './presets.js'
import { runGeneration } from './runner.js'
import { formatResult, renderFailureText } from './result.js'
import { logDebug } from './log.js'

export const TOOL_NAME_DEFAULT = 'generate_image'

export const TOOL_DESCRIPTION = [
  '用本地 Qwen-Image-2.1 模型生成图片（文生图）。插件会自动拉起/复用本地 ComfyUI，不需要用户手动开服务。',
  '',
  '档位 preset（不知道选哪个就用 standard）：',
  '  fast         1024² 25 步，最快，适合草稿和试构图',
  '  standard     1024² 40 步，官方参数（cfg=1 / euler / simple），默认档',
  '  turbo        8 步极速（turbo DiT），细节弱一些，适合大量试错',
  '  quality      原生 2K（约 4MP，长边最大 2752），成稿用，慢',
  '  transparent  透明背景，直接产出带 alpha 的 PNG（不要再说“去背景”，也不需要后期抠图）',
  '',
  '尺寸：默认 1024×1024。可用 aspect_ratio 选 1:1 / 4:3 / 3:4 / 3:2 / 2:3 / 16:9 / 9:16；',
  '也可直接给 width/height（会向上对齐到 32 的倍数）。',
  '',
  '提示词：中英文都可以，模型原生支持中文；建议写清楚主体、风格、构图、光线。',
  '想要透明背景用 preset=transparent 或 transparent=true，不要自己在提示词里堆“去背景”。',
  '',
  '返回：',
  '  - 文本里「图片：<绝对路径>」就是成品，同时给了一行 markdown 图片引用；',
  '  - 想复现同一张图：把返回的 seed 原样传回来；',
  '  - 每次产出都有 .json sidecar（含完整工作流），可贴回 ComfyUI 界面复现。',
  '',
  '注意：首次调用要把 13~17 GB 权重搬进显存，可能等 1~3 分钟；之后同档位调用会快很多。',
  '若返回“模型列表里没有…”，说明权重没放好或 ComfyUI 下载后没重启。',
  '',
  '工作方法（强烈建议）：',
  '  - 用户描述含糊、或存在多种合理解读时，先列出 2–4 种**明显不同**的猜想（构图/风格/主体侧重/氛围）。',
  '  - 为每种猜想细化成高质量提示词（主体+风格+构图+光线+配色+画幅），然后一次调用 generate_variants，',
  '    每条给一个 label，让每种情况都出一张图交给用户挑。',
  '  - 生成后用 read_image 逐张检查是否符合意图；只有全部方案都明显偏差时才回头追问用户。',
  '',
  'SKILL 合规（重要）：',
  '  - 本工具**只出一张图**，仅用于：用户明确只要一张、或对已有图做单次微调。',
  '  - 用户提出「画配图 / 示意图 / 科普图 / PPT 配图」等**需求级**出图时，必须按内置 SKILL 执行：',
  '      read_prompt_skill（读 SKILL）',
  '      → plan_prompts（语义维 2–3 解读 × 风格维 4 个不同分类，返回 groups 给子智能体）',
  '      → 每个子智能体 generate_variants 出图（或主智能体直接 generate_from_brief）',
  '      → assemble_captions / export_ppt 组装文字版',
  '  - 若检测到需求级长提示词且未传 single_image_ok=true，本工具会拒绝执行并提示正确流程。'
].join('\n')

export const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: '要画什么。中英文都行，写清楚主体/风格/构图/光线。透明背景不要写“去背景”，用 transparent 参数。'
    },
    single_image_ok: { type: 'boolean', description: '确认只要单张图时传 true（否则需求级长提示词会被 SKILL 合规拦截）' },
    preset: {
      type: 'string',
      enum: [...PRESET_NAMES],
      description: '档位：fast(25步草稿) / standard(40步默认) / turbo(8步极速) / quality(原生2K) / transparent(透明背景)'
    },
    aspect_ratio: {
      type: 'string',
      enum: Object.keys(ASPECTS_1MP),
      description: '画面比例，默认 1:1。quality 档会映射到官方原生 2K 尺寸。'
    },
    width: { type: 'integer', description: '输出宽度，自动对齐到 32 的倍数；与 aspect_ratio 二选一' },
    height: { type: 'integer', description: '输出高度，自动对齐到 32 的倍数' },
    steps: { type: 'integer', description: '采样步数 1~80；不传用档位默认（standard=40）' },
    seed: { type: 'integer', description: '随机种子；不传随机。传上次返回的 seed 可复现同一张图' },
    transparent: { type: 'boolean', description: 'true = 生成带 alpha 的透明背景 PNG（等价 preset=transparent）' },
    negative_prompt: {
      type: 'string',
      description: '不想要的东西。注意：cfg=1 时官方不使用负向提示词，传了会自动把 cfg 提到 4'
    },
    cfg_scale: { type: 'number', description: '提示词贴合度，官方路径是 1；一般不用改' },
    output_path: {
      type: 'string',
      description: '输出目录或带扩展名的文件路径；默认 <会话工作目录>/gen/，同名会自动加 -1/-2 后缀，绝不覆盖'
    },
    timeout_ms: { type: 'integer', description: '单次超时（毫秒），默认 900000；首张图建议别小于 300000' }
  },
  required: ['prompt'],
  additionalProperties: false
}

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '给模型看的完整结果说明（含图片路径与 markdown 引用）' },
    path: { type: 'string', description: '产出图片的绝对路径' },
    files: { type: 'array', items: { type: 'string' }, description: '本次产出的全部文件（图片 + sidecar）' },
    preset: { type: 'string', description: '实际使用的档位' },
    seed: { type: 'integer', description: '本次种子' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    steps: { type: 'integer' },
    transparent: { type: 'boolean', description: '是否透明背景' },
    prompt_id: { type: 'string', description: 'ComfyUI 的 prompt_id，便于排查' },
    comfy_url: { type: 'string', description: '本次使用的 ComfyUI 地址' },
    duration_ms: { type: 'integer', description: '总耗时（含启动/排队/采样/取回）' },
    gate: {
      type: 'object',
      properties: {
        passed: { type: 'boolean' },
        summary: { type: 'string' },
        checks: { type: 'array', items: { type: 'string' } }
      },
      required: ['passed', 'summary'],
      additionalProperties: false
    },
    models: {
      type: 'object',
      properties: {
        unet: { type: 'string' },
        clip: { type: 'string' },
        vae: { type: 'string' }
      },
      required: ['unet', 'clip', 'vae'],
      additionalProperties: false
    },
    success: { type: 'boolean', description: '是否成功（门禁未通过时为 false，但图仍保留）' }
  },
  required: ['text', 'path', 'files', 'preset', 'seed', 'width', 'height', 'steps', 'success'],
  additionalProperties: false
}

/** 从执行上下文里挖会话工作目录，挖不到退回进程 cwd（防御式，绝不因此报错）。 */
export function resolveCwd(exec) {
  const agent = exec && exec.agent
  if (agent) {
    const candidates = [
      agent.cwd,
      agent.meta && agent.meta.cwd,
      agent.session && agent.session.cwd,
      agent.session && agent.session.header && agent.session.header.cwd
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
    }
  }
  return process.cwd()
}

/**
 * 造出工具定义。配置是每次调用重新解析的，所以改 config.json 立即生效。
 */
export function createGenerateImageTool(pluginConfig) {
  const bootConfig = resolveConfig(pluginConfig)
  const toolName = bootConfig.toolName || TOOL_NAME_DEFAULT

  return {
    name: toolName,
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS_SCHEMA,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      presentationMeta: (_args, value) => ({
        kind: 'image-generation',
        path: (value && value.path) || '',
        preset: (value && value.preset) || '',
        seed: (value && value.seed) || 0,
        width: (value && value.width) || 0,
        height: (value && value.height) || 0
      })
    },
    async execute(args, exec) {
      const rawArgs = args || {}
      const promptText = String(rawArgs.prompt || '')
      const demandLike = promptText.length >= 40 && /[。；;]/.test(promptText) && !/单张|一张|微调|only one/.test(promptText)
      if (rawArgs.single_image_ok !== true && demandLike) {
        throw new Error(
          'SKILL 合规拦截：这是需求级提示词（' + promptText.length + ' 字），不能直接出单张图。\n' +
          '必须按内置 SKILL 执行：read_prompt_skill → plan_prompts（2–3 种释义 × 4 个风格分类）→ 子智能体分别 generate_variants（或直接 generate_from_brief）。\n' +
          '如果你确实只要一张图（例如单次微调），请传 single_image_ok: true。'
        )
      }
      const config = resolveConfig(pluginConfig)
      ensureDir(CONFIG_DIR)
      const cwd = resolveCwd(exec)
      logDebug('execute', { cwd, tool: toolName })
      try {
        const run = await runGeneration({
          args: args || {},
          cwd,
          config,
          signal: exec && exec.signal ? exec.signal : undefined,
          log: (msg) => logDebug('runner', msg)
        })
        return formatResult(run)
      } catch (error) {
        // 失败也把「为什么 + 怎么办」交给模型，比抛个 fetch failed 有用得多
        throw new Error(renderFailureText(error))
      }
    }
  }
}
