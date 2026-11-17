/** 模型管理工具：image_models（list / search / files / download / select / delete）。 */

import { resolveConfig } from './config.js'
import { createGenerateImageTool } from './tool.js'
import {
  ROLE_FOLDERS,
  ROLE_LABELS,
  deleteModel,
  downloadModel,
  listLocalModels,
  listRepoFiles,
  modelsRoot,
  searchRemoteModels,
  selectModel
} from './models.js'
import { renderFailureText } from './result.js'
import { logDebug } from './log.js'

export const MODELS_TOOL_NAME_DEFAULT = 'image_models'

export const MODELS_TOOL_DESCRIPTION = [
  '管理本地图像生成模型（静态逻辑，不消耗推理算力）：列出本地模型、按关键词搜索模型仓库、查看仓库文件、下载权重、切换档位使用的模型、删除不用的模型。',
  '',
  '动作 action：',
  '  list     列出 ComfyUI models 目录里的权重文件（含大小、可充当的角色、当前是否被选中）',
  '  search   按关键词搜索模型仓库；provider 可选 modelscope（默认，国内可达）/ huggingface',
  '  files    列出某仓库某目录下的权重文件，给出可下载 URL；folder 一般是 diffusion_models / text_encoders / vae',
  '  download 下载一个权重文件到 ComfyUI 对应目录（.part 断点续传 + 大小校验；大文件耗时较长）',
  '  select   把某个角色（unet / unetTurbo / clip / clipLean / vae）切换成指定本地文件',
  '  delete   删除本地权重文件（不能删正在使用的；models.allowDelete=false 时禁用）',
  '',
  '典型流程：',
  '  1) image_models({action:"search", keyword:"qwen-image"})',
  '  2) image_models({action:"files", repo:"Comfy-Org/Qwen-Image-2.1", folder:"diffusion_models"})',
  '  3) image_models({action:"download", url:"...", folder:"diffusion_models"})',
  '  4) image_models({action:"select", role:"unet", name:"xxx.safetensors"})',
  '',
  '角色说明：',
  ...Object.entries(ROLE_LABELS).map(([role, label]) => `  ${role}  ${label}（目录 ${ROLE_FOLDERS[role]}）`),
  '',
  '注意：download 之后需要重启 ComfyUI 才会被扫描到；插件会在下次出图时自动处理端口与进程。'
].join('\n')

export const MODELS_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'search', 'files', 'download', 'select', 'delete'],
      description: '要做的操作'
    },
    keyword: { type: 'string', description: 'search 用的关键词，例如 qwen-image、flux、sdxl' },
    provider: { type: 'string', enum: ['modelscope', 'huggingface'], description: 'search/files 的来源，默认 modelscope' },
    repo: { type: 'string', description: 'files 用的仓库名，例如 Comfy-Org/Qwen-Image-2.1' },
    folder: {
      type: 'string',
      description: 'files 时的子目录（diffusion_models / text_encoders / vae）；download 时的目标目录，必须是这三者之一'
    },
    url: { type: 'string', description: 'download 用的文件下载地址' },
    filename: { type: 'string', description: 'download 时可选，覆盖保存文件名' },
    role: {
      type: 'string',
      enum: Object.keys(ROLE_FOLDERS),
      description: 'select / delete 时的模型角色'
    },
    name: { type: 'string', description: 'select / delete 时的本地文件名' },
    limit: { type: 'integer', description: 'search 返回条数，默认 10，最大 50' }
  },
  required: ['action'],
  additionalProperties: false
}

export const MODELS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '给模型/用户看的结果说明' },
    action: { type: 'string', description: '实际执行的动作' },
    success: { type: 'boolean' },
    items: { type: 'array', items: { type: 'string' }, description: '逐条结果（文件/仓库等）' },
    note: { type: 'string', description: '后续操作提示' }
  },
  required: ['text', 'action', 'success'],
  additionalProperties: false
}

function formatLocalList(result) {
  const lines = [`本地模型目录：${result.root}`]
  if (!result.items.length) {
    lines.push('（空）还没有任何权重文件。先用 action=search 找到仓库，再 files / download。')
    return lines.join('\n')
  }
  let currentFolder = ''
  for (const item of result.items) {
    if (item.folder !== currentFolder) {
      currentFolder = item.folder
      lines.push('')
      lines.push(`[${item.folder}]`)
    }
    const marks = []
    if (item.selected) marks.push(`使用中:${item.selectedFor.join(',')}`)
    lines.push(`  ${item.name}  ${item.sizeGb} GB${marks.length ? `  (${marks.join('; ')})` : ''}`)
  }
  lines.push('')
  lines.push('当前选中：' + Object.entries(result.selected).map(([role, name]) => `${role}=${name || '未设置'}`).join('  '))
  return lines.join('\n')
}

/**
 * @param {object} args 工具入参
 * @param {object} config 已解析配置
 * @returns {Promise<{text: string, action: string, success: boolean, items?: string[], note?: string}>}
 */
export async function runModelsAction(args, config) {
  const action = String((args && args.action) || '').trim()
  if (action === 'list') {
    const result = listLocalModels(config)
    return {
      text: formatLocalList(result),
      action,
      success: true,
      items: result.items.map((item) => `${item.folder}/${item.name}`),
      note: 'select 可以切换档位使用的模型；delete 删除不用的文件'
    }
  }

  if (action === 'search') {
    const result = await searchRemoteModels(config, args.keyword, { provider: args.provider, limit: args.limit })
    const lines = [`关键词「${result.keyword}」的搜索结果：`]
    const items = result.results.map((entry) => {
      lines.push(`  ${entry.id}  ${entry.provider}  ↓${entry.downloads}  ★${entry.likes}`)
      return entry.id
    })
    if (!result.results.length) lines.push('  （无结果）')
    for (const error of result.errors) lines.push(`  注意：${error}`)
    lines.push('')
    lines.push('下一步：action=files repo=<上面某个 id> folder=<diffusion_models|text_encoders|vae>')
    return { text: lines.join('\n'), action, success: result.results.length > 0, items, note: '用 files 查看该仓库的文件' }
  }

  if (action === 'files') {
    const result = await listRepoFiles(config, args)
    const lines = [`${result.repo}${result.folder ? ` / ${result.folder}` : ''} 的文件：`]
    const items = []
    for (const file of result.files) {
      if (file.type === 'dir') {
        lines.push(`  [目录] ${file.name}`)
      } else {
        lines.push(`  ${file.name}  ${file.sizeGb} GB`)
        items.push(file.url)
      }
    }
    if (!items.length) lines.push('  （这个目录下没有权重文件，换一个 folder 试试）')
    lines.push('')
    lines.push('下一步：action=download folder=<目录> url=<对应文件的 URL>')
    return { text: lines.join('\n'), action, success: result.files.length > 0, items, note: '把 items 里的 URL 交给 download' }
  }

  if (action === 'download') {
    const result = await downloadModel(config, {
      url: args.url,
      folder: args.folder,
      filename: args.filename
    })
    const text = result.skipped
      ? `文件已存在，未覆盖：${result.file}`
      : `已下载：${result.file}\n大小：${result.sizeGb} GB\n重启 ComfyUI 后会被扫描到（插件下次出图会自动处理）。`
    return { text, action, success: true, items: [result.file], note: '可以用 action=select 把它设为某档位使用的模型' }
  }

  if (action === 'select') {
    const result = selectModel(config, args.role, args.name)
    return {
      text: `已切换 ${result.role} → ${result.folder}/${result.name}\n（配置文件已更新；下次出图生效）`,
      action,
      success: true,
      items: [`${result.folder}/${result.name}`]
    }
  }

  if (action === 'delete') {
    const result = deleteModel(config, args.role, args.name)
    return {
      text: `已删除 ${result.deleted}，释放 ${result.freedGb} GB`,
      action,
      success: true,
      items: [result.deleted]
    }
  }

  throw new Error(`未知 action=${action}，可选：list / search / files / download / select / delete`)
}

export function createImageModelsTool(pluginConfig) {
  const bootConfig = resolveConfig(pluginConfig)
  const toolName = bootConfig.modelsToolName || MODELS_TOOL_NAME_DEFAULT
  return {
    name: toolName,
    description: MODELS_TOOL_DESCRIPTION,
    parameters: MODELS_PARAMETERS_SCHEMA,
    output: {
      schema: MODELS_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }]
    },
    async execute(args) {
      const config = resolveConfig(pluginConfig)
      logDebug('models-tool', { action: args && args.action })
      try {
        return await runModelsAction(args || {}, config)
      } catch (error) {
        throw new Error(renderFailureText(error))
      }
    }
  }
}
