/**
 * 插件入口（宿主侧）。
 *
 * 注册两件事：
 *   1. 工具：generate_image（出图）+ image_models（模型管理，纯静态逻辑）
 *   2. Web 宿主的 HTTP 接口（设置页用；desktop 没有 webServer 时自动跳过）
 *
 * 注意：这里**不 import 任何 @deepseek-ai/* 宿主包**——link 安装时 Node 从物理路径
 * 往上找 node_modules 会 ERR_MODULE_NOT_FOUND。
 */

import { CONFIG_DIR, PLUGIN_NAME, describeConfig, ensureDir, resolveConfig } from './config.js'
import { createGenerateImageTool, TOOL_NAME_DEFAULT } from './tool.js'
import { createEditImageTool, EDIT_TOOL_NAME_DEFAULT } from './edit-tool.js'
import { createImageModelsTool, MODELS_TOOL_NAME_DEFAULT } from './models-tool.js'
import { createGenerateVariantsTool, VARIANTS_TOOL_NAME_DEFAULT } from './variants-tool.js'
import { createComposePromptsTool, COMPOSE_TOOL_NAME_DEFAULT } from './compose-tool.js'
import { createGenerateFromBriefTool, BRIEF_TOOL_NAME_DEFAULT } from './brief-tool.js'
import { createAssembleCaptionsTool, CAPTIONS_TOOL_NAME_DEFAULT } from './captions-tool.js'
import { createExportPptTool, PPT_TOOL_NAME_DEFAULT } from './ppt-tool.js'
import { createReadPromptSkillTool, createPlanPromptsTool, SKILL_TOOL_NAME_DEFAULT, PLAN_TOOL_NAME_DEFAULT } from './skill-tool.js'
import { registerApi } from './api.js'
import { logInfo, logWarn } from './log.js'

export const name = PLUGIN_NAME

export const inject = ['tools']

function getToolRegistry(ctx) {
  const candidates = []
  if (ctx && ctx.reflect && typeof ctx.reflect.get === 'function') {
    candidates.push(ctx.reflect.get('tools', false))
    candidates.push(ctx.reflect.get('tools'))
  }
  if (ctx && typeof ctx.get === 'function') candidates.push(ctx.get('tools'))
  for (const candidate of candidates) {
    if (candidate && typeof candidate.register === 'function') return candidate
  }
  return undefined
}

function registerWebApi(ctx, config) {
  if (!ctx || typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['webServer'], (webCtx) => {
      try {
        webCtx.effect(() => registerApi(webCtx, config), 'image-generation-ks: http api')
      } catch (error) {
        logWarn('注册 HTTP 接口失败（设置页按钮不可用，工具不受影响）：' + error.message)
      }
    })
  } catch (error) {
    logWarn('宿主没有 webServer 服务，跳过设置页接口：' + error.message)
  }
}

export function apply(ctx, config) {
  const tools = getToolRegistry(ctx)
  if (!tools) {
    logWarn('拿不到 tools 服务，generate_image / image_models 未注册（检查 profile 里插件依赖与 patch 是否生效）')
    return
  }

  const resolved = resolveConfig(config)
  ensureDir(CONFIG_DIR)

  const imageTool = createGenerateImageTool(config)
  tools.register(imageTool)

  const editTool = createEditImageTool(config)
  tools.register(editTool)

  const modelsTool = createImageModelsTool(config)
  tools.register(modelsTool)

  const variantsTool = createGenerateVariantsTool(config)
  tools.register(variantsTool)

  const composeTool = createComposePromptsTool(config)
  tools.register(composeTool)

  const briefTool = createGenerateFromBriefTool(config)
  tools.register(briefTool)

  const captionsTool = createAssembleCaptionsTool(config)
  tools.register(captionsTool)

  const pptTool = createExportPptTool(config)
  tools.register(pptTool)

  const skillTool = createReadPromptSkillTool()
  tools.register(skillTool)

  const planTool = createPlanPromptsTool(config)
  tools.register(planTool)

  registerWebApi(ctx, config)

  // 加载阶段不发网络请求、不启动子进程：ComfyUI 只在第一次出图时懒启动
  logInfo(
    `v0.2.2 已就绪，注册工具 ${imageTool.name || TOOL_NAME_DEFAULT} + ${editTool.name || EDIT_TOOL_NAME_DEFAULT} + ${modelsTool.name || MODELS_TOOL_NAME_DEFAULT} + ${variantsTool.name || VARIANTS_TOOL_NAME_DEFAULT} + ${composeTool.name || COMPOSE_TOOL_NAME_DEFAULT} + ${briefTool.name || BRIEF_TOOL_NAME_DEFAULT} + ${captionsTool.name || CAPTIONS_TOOL_NAME_DEFAULT} + ${pptTool.name || PPT_TOOL_NAME_DEFAULT} + ${skillTool.name || SKILL_TOOL_NAME_DEFAULT} + ${planTool.name || PLAN_TOOL_NAME_DEFAULT}；${describeConfig(resolved)}`
  )
}

/* ─────────── 便于离线单测的再导出（不启动 DSH 也能 import） ─────────── */
export { buildText2Img, describeModels, NODE_IDS } from './workflow.js'
export { normalizeRequest, wrapTransparentPrompt } from './params.js'
export { PRESETS, PRESET_NAMES, ASPECTS_1MP, ASPECTS_4MP, sizeFor, align32 } from './presets.js'
export { ComfyClient, systemSummary } from './comfy.js'
export { ensureServer, healthAt, isPortFree, scheduleIdleShutdown, shutdownOwnedServer, ownedInfo } from './server.js'
export { DEFAULT_CONFIG, CONFIG_FILE, CONFIG_DIR, PLUGIN_NAME, resolveConfig, readRuntime, writeRuntime } from './config.js'
export { formatResult, renderFailureText } from './result.js'
export { gateImage, pngInfo } from './gate.js'
export { runGeneration, assertComfyReady } from './runner.js'
export { createGenerateImageTool, PARAMETERS_SCHEMA, OUTPUT_SCHEMA, TOOL_DESCRIPTION, resolveCwd } from './tool.js'
export { createEditImageTool, EDIT_TOOL_DESCRIPTION, EDIT_PARAMETERS_SCHEMA, EDIT_OUTPUT_SCHEMA, EDIT_TOOL_NAME_DEFAULT } from './edit-tool.js'
export { runEdit, buildEditWorkflow, formatEditResult, normalizeEditRequest, maskOutsideDiff, fitEditSize, MASK_OUTSIDE_TOLERANCE } from './edit.js'
export { createImageModelsTool, runModelsAction, MODELS_TOOL_DESCRIPTION, MODELS_PARAMETERS_SCHEMA } from './models-tool.js'
export { createGenerateVariantsTool, formatVariantsResult, VARIANTS_TOOL_DESCRIPTION, VARIANTS_PARAMETERS_SCHEMA } from './variants-tool.js'
export { createComposePromptsTool, COMPOSE_TOOL_DESCRIPTION } from './compose-tool.js'
export { createGenerateFromBriefTool, BRIEF_TOOL_DESCRIPTION } from './brief-tool.js'
export { createAssembleCaptionsTool, CAPTIONS_TOOL_DESCRIPTION } from './captions-tool.js'
export { createExportPptTool, PPT_TOOL_DESCRIPTION } from './ppt-tool.js'
export { createReadPromptSkillTool, createPlanPromptsTool, SKILL_TOOL_DESCRIPTION, PLAN_TOOL_DESCRIPTION } from './skill-tool.js'
export { runExportPpt } from './ppt.js'
export { planCaptionBoxes, runCaptionAssembly } from './captions.js'
export { loadSkill, parseSkill, skillPromptBlock, skillSummary, skillDefaults, SKILL_CANDIDATES } from './skill.js'
export { composePrompts, analyzeBrief, listCatalog, STYLE_FAMILIES, FORMS, RATIOS } from './prompt-angles.js'
export { runVariants } from './batch.js'
export {
  listLocalModels,
  searchRemoteModels,
  listRepoFiles,
  downloadModel,
  deleteModel,
  selectModel,
  modelsRoot,
  ROLE_FOLDERS,
  ROLE_LABELS
} from './models.js'
export { registerApi, openInDefaultBrowser } from './api.js'
export { ImagePluginError, CODES, formatError } from './errors.js'
