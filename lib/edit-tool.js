/** 工具契约：edit_image —— 用文字对已有图做图生图 / 局部修改。 */

import { PRESET_NAMES } from './presets.js'
import { runEdit, formatEditResult, MASK_OUTSIDE_TOLERANCE } from './edit.js'
import { resolveCwd } from './tool.js'
import { renderFailureText } from './result.js'
import { resolveConfig } from './config.js'

export const EDIT_TOOL_NAME_DEFAULT = 'edit_image'

export const EDIT_TOOL_DESCRIPTION = [
  '对一张已有图片做「按文字修改」：图生图（整图重画、保留构图）或局部修改（只改遮罩内）。',
  '底层是本地 Qwen-Image-2.1，插件会自动拉起/复用 ComfyUI。',
  '',
  '两种用法：',
  '  - 局部修改：传 image + mask + prompt。mask 里白色（>128）的区域允许改，黑色区域保持不动；',
  '    prompt 只描述「这块要变成什么」，不要重复描述整张图。',
  '  - 精确改色：传 image + mask + color（#RRGGBB）。不跑模型，按原图明暗把遮罩内换成目标色，',
  '    黑线、按钮和高光原样保留；适合「只把这块面板改成亮红色」这类平涂改色。',
  '  - 图生图：只传 image + prompt，不传 mask。denoise 控制改动幅度：0.3 轻微调色/换风格，',
  '    0.55 默认，0.75 以上接近重画但保留构图。',
  '',
  '遮罩建议：',
  '  - mask 必须是 PNG，和输入图不必同尺寸（会缩放到输入图大小）；白色=改，黑色=不改。',
  '  - 只框住要改的零件，不要把整张脸/整个主体都包进去；遮罩越准，越不会误伤。',
  '  - 想改「头盔外壳」就别把透明面罩框进去，否则面罩后的脸也会被重画。',
  '',
  '返回：',
  '  - 「图片：<绝对路径>」是结果，同时给 markdown 图片引用；原图绝不覆盖；',
  '  - 局部修改会报告「遮罩内/外平均变化」，遮罩外 > 阈值（默认 8）时门禁不通过，图仍保留；',
  '  - 每次都有 .json sidecar（含完整工作流），可贴回 ComfyUI 复现。',
  '',
  '工作方法：',
  '  - 修改前先 read_image 看原图，确认要改的区域和不该动的区域；',
  '  - 生成后再 read_image 检查：主体是否保留、遮罩外是否被误改、文字指令是否真的生效；',
  '  - 不满意就调 prompt / 缩小 mask / 降 denoise 重试，不要把整张图重画当“局部修改”。',
  '',
  '注意：首次调用要把 13~17 GB 权重搬进显存，可能等 1~3 分钟；之后同档位会快很多。'
].join('\n')

export const EDIT_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    image: {
      type: 'string',
      description: '输入图路径（PNG；绝对路径或相对会话工作目录）'
    },
    prompt: {
      type: 'string',
      description: '要改成什么。局部修改只描述遮罩里的内容；图生图描述整张图的新样子。'
    },
    mask: {
      type: 'string',
      description: '可选，PNG 遮罩：白色（>128）=允许改，黑色=保持。传了就是局部修改。'
    },
    color: {
      type: 'string',
      description: '精确改色目标色 #RRGGBB（如 #E00000）。必须同时给 mask；给了它就不跑模型，按原图明暗换色、保留线条。'
    },
    denoise: {
      type: 'number',
      description: '改动幅度 0.05~1。有 mask 时默认 0.85（保留原图线条与结构，只染/改遮罩内）；1.0 是完全重画遮罩内。无 mask 时默认 0.55。'
    },
    preset: {
      type: 'string',
      enum: [...PRESET_NAMES],
      description: '档位：fast(25步) / standard(40步) / turbo(8步) / quality(2K)；编辑一般 fast 就够'
    },
    steps: { type: 'integer', description: '采样步数 1~80；不传用档位默认' },
    seed: { type: 'integer', description: '随机种子；传上次的 seed 可复现' },
    negative_prompt: { type: 'string', description: '不想要的东西；传了会自动把 cfg 提到 4' },
    cfg_scale: { type: 'number', description: '提示词贴合度，默认 1' },
    max_side: { type: 'integer', description: '输入图长边上限，默认 1024；会按 16 对齐' },
    output_path: { type: 'string', description: '输出目录或文件名；默认 <outputDir>/edits/，同名自动加后缀' },
    timeout_ms: { type: 'integer', description: '单次超时（毫秒），默认 900000' }
  },
  required: ['image', 'prompt'],
  additionalProperties: false
}

export const EDIT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    path: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    source_path: { type: 'string' },
    mask_path: { type: 'string' },
    preset: { type: 'string' },
    seed: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    steps: { type: 'integer' },
    denoise: { type: 'number' },
    prompt_id: { type: 'string' },
    duration_ms: { type: 'integer' },
    mask_inside_diff: { type: 'number' },
    mask_outside_diff: { type: 'number' },
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
    success: { type: 'boolean' }
  },
  required: ['text', 'path', 'files', 'source_path', 'seed', 'width', 'height', 'steps', 'success'],
  additionalProperties: false
}

export function createEditImageTool(pluginConfig) {
  return {
    name: EDIT_TOOL_NAME_DEFAULT,
    description: EDIT_TOOL_DESCRIPTION,
    parameters: EDIT_PARAMETERS_SCHEMA,
    output: {
      schema: EDIT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      presentationMeta: (_args, value) => ({
        kind: 'image-edit',
        path: (value && value.path) || '',
        source: (value && value.source_path) || '',
        seed: (value && value.seed) || 0,
        maskOutsideDiff: value ? value.mask_outside_diff : null
      })
    },
    async execute(args, exec) {
      try {
        const run = await runEdit({
          args: args || {},
          cwd: resolveCwd(exec),
          config: resolveConfig(pluginConfig),
          signal: exec && exec.signal ? exec.signal : undefined
        })
        return formatEditResult(run)
      } catch (error) {
        throw new Error(renderFailureText(error))
      }
    }
  }
}

export { MASK_OUTSIDE_TOLERANCE }
