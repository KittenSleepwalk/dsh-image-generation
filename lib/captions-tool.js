/** 工具：assemble_captions —— 把生成的底案图 + 标签清单，组装成带文本框/气泡框的文字版。 */

import { resolveConfig } from './config.js'
import { planCaptionBoxes, runCaptionAssembly, formatCaptionResult } from './captions.js'
import { renderFailureText } from './result.js'
import { logDebug } from './log.js'

export const CAPTIONS_TOOL_NAME_DEFAULT = 'assemble_captions'

export const CAPTIONS_TOOL_DESCRIPTION = [
  '给已生成的底案图**专门组装文本框/气泡框**（图像与文字分离，SKILL H 条）。',
  '解决「让模型自己画空框」的问题：模型只负责留干净区域，框和字由脚本确定性绘制——',
  '位置、尺寸、圆角、配色、引导线、字号、换行都可控，并输出 captions.json 方便 PPT/PS 回填。',
  '',
  '流程：',
  '  1. generate_image / generate_from_brief 出图（默认 clean-zones：画面只留干净区域，不画框不画字）',
  '  2. 把标签清单交给本工具：标题、每层/每元素短标签、底部结论、提示气泡',
  '  3. 得到三件套：*_底案.png（原图）/ *_文字版.png（带框带字）/ *_captions.json（框位清单）',
  '',
  '参数：',
  '  base_image       底案图路径（必填）',
  '  labels           标签数组；每项 {text, shape?, side?, anchor?:[x,y]（0-1 相对坐标）, color?}',
  '                   shape：title 标题胶囊 / label 贴边标签（带引导线）/ bubble 气泡 / footer 底部结论条',
  '  output_path      输出目录（默认与底案同目录）',
  '  basename         输出文件名前缀（默认取底案文件名）',
  '',
  '自动排版：未给 anchor 时，label 默认在右侧纵向均分并指向左中区域；title 在左上，footer 在底部居中。'
].join('\n')

export const CAPTIONS_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    base_image: { type: 'string', description: '底案图路径' },
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '标签文字（中文短句，建议 ≤10 字）' },
          shape: { type: 'string', description: 'title / label / bubble / footer' },
          side: { type: 'string', description: 'left / right（贴边标签方向）' },
          anchor_x: { type: 'number', description: '引导线锚点 x（0-1 相对坐标）' },
          anchor_y: { type: 'number', description: '引导线锚点 y（0-1 相对坐标）' },
          color: { type: 'string', description: '框线颜色，如 #3b7ea1' }
        },
        required: ['text'],
        additionalProperties: false
      },
      description: '标签清单（自动排版；可给 anchor 精确指向元素）'
    },
    output_path: { type: 'string', description: '输出目录' },
    basename: { type: 'string', description: '输出文件名前缀' }
  },
  required: ['base_image', 'labels'],
  additionalProperties: false
}

export const CAPTIONS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '组装结果说明' },
    files: { type: 'array', items: { type: 'string' }, description: '底案/文字版/manifest 路径' },
    boxCount: { type: 'integer', description: '文本框数量' }
  },
  required: ['text', 'files', 'boxCount'],
  additionalProperties: false
}

export function createAssembleCaptionsTool(pluginConfig) {
  const bootConfig = resolveConfig(pluginConfig)
  const toolName = bootConfig.captionsToolName || CAPTIONS_TOOL_NAME_DEFAULT
  return {
    name: toolName,
    description: CAPTIONS_TOOL_DESCRIPTION,
    parameters: CAPTIONS_PARAMETERS_SCHEMA,
    output: {
      schema: CAPTIONS_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      presentationMeta: (_args, value) => ({
        kind: 'image-generation',
        path: (value && value.files && value.files[1]) || (value && value.files && value.files[0]) || '',
        count: (value && value.boxCount) || 0
      })
    },
    async execute(args) {
      const input = args || {}
      const labels = (input.labels || []).map((item) => ({
        text: item.text,
        shape: item.shape,
        side: item.side,
        color: item.color,
        anchor: typeof item.anchor_x === 'number' && typeof item.anchor_y === 'number' ? [item.anchor_x, item.anchor_y] : undefined
      }))
      logDebug('captions-tool', { base: input.base_image, labels: labels.length })
      try {
        const result = await runCaptionAssembly({
          config: pluginConfig,
          baseImage: input.base_image,
          rawLabels: labels,
          labels: planCaptionBoxes(labels),
          outputDir: input.output_path,
          basename: input.basename
        })
        return {
          text: formatCaptionResult(result),
          files: [result.basePath, result.textPath, result.manifestPath],
          boxCount: result.boxes.length
        }
      } catch (error) {
        throw new Error(renderFailureText(error))
      }
    }
  }
}
