/** 工具：export_ppt —— 底案图 → 可编辑 PPTX（白色圆角标注 + 彩色边框 + 圆点虚线引导 + 底部结论条）。 */

import { resolveConfig } from './config.js'
import { runExportPpt, formatPptResult } from './ppt.js'
import { renderFailureText } from './result.js'
import { logDebug } from './log.js'

export const PPT_TOOL_NAME_DEFAULT = 'export_ppt'

export const PPT_TOOL_DESCRIPTION = [
  '把底案图导出成**可编辑 PPTX**（对齐参考样例「底案 → PPT 加字 → 截图文字版」的工作流）。',
  '文字与文字框全部由 PPT 生成：气泡框/标注框用**透明 PNG 素材**（框外无底色、可拉伸），文字是原生文本框；PPTX 原件保存，方便调版。',
  'PPT 里是原生的圆角标注形状：白底、彩色 1.5pt 边框、微软雅黑 15pt 彩色文字、同色圆点虚线引导线，底部可加结论条；',
  '打开 PPT 就能改字/挪框/加字号，改完截图即为文字版成品（比代码栅格化更灵活）。',
  '',
  '参数：',
  '  base_image   底案图（无文字框）',
  '  labels       标注数组：[{text, shape:"callout"|"bubble"|"tag"|"footer", side:"left"|"right"|"top"|"bottom", anchor:[x,y]（0-1）, color}]',
  '  output_path  输出目录',
  '  basename     输出文件名（不含扩展名）',
  '  slide_width / slide_height  默认 1280×720（16:9，与参考样例一致）',
  '',
  '提示：标注文字保持短句（≤10 字），参考样例用 4 个侧边标注 + 1 条底部结论 + 圆点虚线指向元素。'
].join('\n')

export const PPT_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    base_image: { type: 'string', description: '底案图路径（无文字框）' },
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          shape: { type: 'string', description: 'callout / footer' },
          side: { type: 'string', description: 'left / right / top / bottom' },
          anchor_x: { type: 'number', description: '引导线锚点 x（0-1）' },
          anchor_y: { type: 'number', description: '引导线锚点 y（0-1）' },
          color: { type: 'string', description: '框线/文字颜色，如 #3b7ea1' }
        },
        required: ['text'],
        additionalProperties: false
      }
    },
    output_path: { type: 'string' },
    basename: { type: 'string' },
    slide_width: { type: 'integer' },
    slide_height: { type: 'integer' }
  },
  required: ['base_image', 'labels'],
  additionalProperties: false
}

export const PPT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    file: { type: 'string' },
    boxCount: { type: 'integer' }
  },
  required: ['text', 'file', 'boxCount'],
  additionalProperties: false
}

export function createExportPptTool(pluginConfig) {
  const bootConfig = resolveConfig(pluginConfig)
  const toolName = bootConfig.pptToolName || PPT_TOOL_NAME_DEFAULT
  return {
    name: toolName,
    description: PPT_TOOL_DESCRIPTION,
    parameters: PPT_PARAMETERS_SCHEMA,
    output: {
      schema: PPT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      presentationMeta: (_args, value) => ({ kind: 'file', path: (value && value.file) || '' })
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
      logDebug('ppt-tool', { base: input.base_image, labels: labels.length })
      try {
        const result = await runExportPpt({
          config: pluginConfig,
          baseImage: input.base_image,
          labels,
          outputPath: input.output_path,
          basename: input.basename,
          slideWidth: input.slide_width,
          slideHeight: input.slide_height
        })
        return {
          text: formatPptResult(result),
          file: result.pptxPath,
          boxCount: result.boxes.length + (result.footer ? 1 : 0)
        }
      } catch (error) {
        throw new Error(renderFailureText(error))
      }
    }
  }
}
