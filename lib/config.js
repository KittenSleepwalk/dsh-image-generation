/** 配置解析：默认值 ← ~/.dsh-image-generation-ks/config.json ← profile 里的 patch config。 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PLUGIN_NAME = '@kittensleepwalk/dsh-image-generation-ks'
export const CONFIG_DIR = path.join(os.homedir(), '.dsh-image-generation-ks')
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
export const RUNTIME_FILE = path.join(CONFIG_DIR, 'runtime.json')
export const LOG_DIR = path.join(CONFIG_DIR, 'logs')
/** 旧插件（dsh-qwen-image）的配置目录：存在时自动继承，升级不丢配置。 */
export const LEGACY_CONFIG_DIR = path.join(os.homedir(), '.dsh-qwen-image')

/**
 * ComfyUI 安装位置：不再写死机器路径。
 * 优先级：patch config.comfy.root > 环境变量 DSH_COMFY_ROOT > 空（未配置）。
 * 未配置时出图工具会给出“请先配置 ComfyUI 路径”的可读错误，而不是在加载阶段抛错。
 */
export const COMFY_ROOT = expandHome(process.env.DSH_COMFY_ROOT || '')

export const DEFAULT_CONFIG = {
  baseUrl: '',
  comfy: {
    mode: 'auto',
    /** ComfyUI 根目录；为空表示未配置，python/main/cwd 留空则按 root 推导。 */
    root: COMFY_ROOT,
    python: COMFY_ROOT ? path.join(COMFY_ROOT, '.venv', 'Scripts', 'python.exe') : '',
    main: COMFY_ROOT ? path.join(COMFY_ROOT, 'main.py') : '',
    cwd: COMFY_ROOT,
    args: [],
    portCandidates: [8188, 8189, 8190, 8191, 8288, 8388],
    listenHost: '127.0.0.1',
    startTimeoutMs: 240000,
    idleShutdownMs: 900000,
    unloadBeforeShutdown: true,
    /** 点“启动并打开”时用系统默认浏览器打开 ComfyUI 前端（desktop 场景） */
    openInBrowser: true
  },
  models: {
    // 当前选中：档位通过 key 引用这里的文件名
    unet: 'qwen_image_2.1_int8_convrot.safetensors',
    unetTurbo: 'qwen_image_2.1_turbo_int8_convrot.safetensors',
    clip: 'qwen3vl_8b_int8_convrot.safetensors',
    clipLean: 'qwen3vl_8b_w4a8.safetensors',
    vae: 'qwen_image_2.1_vae_bf16.safetensors',
    /** 允许通过接口/工具删除本地模型文件 */
    allowDelete: true,
    /** 关键词搜索的来源顺序：HuggingFace 走 hf-mirror 镜像，ModelScope 的搜索接口需登录 */
    searchProviders: ['huggingface', 'modelscope']
  },
  defaults: {
    preset: 'standard',
    steps: 40,
    cfgScale: 1,
    sampler: 'euler',
    scheduler: 'simple',
    aspectRatio: '1:1',
    timeoutMs: 900000
  },
  /** 空 = <会话工作目录>/gen */
  outputDir: '',
  keepComfyOutput: false,
  useLatentCache: false,
  toolName: 'generate_image',
  /** 模型管理工具名 */
  modelsToolName: 'image_models',
  /** 多方案批量出图工具名 */
  variantsToolName: 'generate_variants',
  /** 角度体系提示词组装工具名 */
  composeToolName: 'compose_prompts',
  /** 文本框/气泡框组装工具名 */
  captionsToolName: 'assemble_captions',
  /** 底案导出可编辑 PPT 工具名 */
  pptxToolName: 'export_ppt',
  /** 设置页/接口前缀（web 宿主才有） */
  apiPath: '/dsh-image-generation-ks/api'
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value)
    else out[key] = value
  }
  return out
}

export function expandHome(input) {
  if (typeof input !== 'string' || input === '') return input
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2))
  return input
}

export function ensureDir(dir) {
  if (!dir) return dir
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file))
  const text = `${JSON.stringify(value, null, 2)}\n`
  fs.writeFileSync(file, text, { encoding: 'utf8' })
  return file
}

/** 读用户配置：新目录优先，没有就继承旧插件目录的配置。 */
export function readUserConfig() {
  const current = readJson(CONFIG_FILE, null)
  if (current) return current
  return readJson(path.join(LEGACY_CONFIG_DIR, 'config.json'), {}) || {}
}

export function resolveConfig(patchConfig) {
  const fileConfig = readUserConfig()
  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, fileConfig), patchConfig || {})
  merged.comfy = merged.comfy || {}
  merged.models = merged.models || {}
  merged.defaults = merged.defaults || {}
  merged.outputDir = expandHome(merged.outputDir || '')
  merged.runtimeFile = expandHome(merged.runtimeFile || '') || RUNTIME_FILE
  merged.comfy.root = expandHome(merged.comfy.root || '')
  if (merged.comfy.root) {
    if (!merged.comfy.python) merged.comfy.python = path.join(merged.comfy.root, '.venv', 'Scripts', 'python.exe')
    if (!merged.comfy.main) merged.comfy.main = path.join(merged.comfy.root, 'main.py')
    if (!merged.comfy.cwd) merged.comfy.cwd = merged.comfy.root
  }
  merged.comfy.python = expandHome(merged.comfy.python || '')
  merged.comfy.main = expandHome(merged.comfy.main || '')
  merged.comfy.cwd = expandHome(merged.comfy.cwd || '')
  const candidates = (merged.comfy.portCandidates || [])
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0 && item < 65536)
  merged.comfy.portCandidates = candidates.length ? [...new Set(candidates)] : [8188]
  merged.comfy.startTimeoutMs = Math.max(10000, Number(merged.comfy.startTimeoutMs) || 240000)
  merged.comfy.idleShutdownMs = Math.max(0, Number(merged.comfy.idleShutdownMs) || 0)
  merged.baseUrl = String(merged.baseUrl || '').replace(/\/+$/, '')
  merged.apiPath = '/' + String(merged.apiPath || '/dsh-image-generation-ks/api').replace(/^\/+/, '').replace(/\/+$/, '')
  const providers = Array.isArray(merged.models.searchProviders) ? merged.models.searchProviders : ['modelscope']
  merged.models.searchProviders = providers.filter((item) => typeof item === 'string')
  return merged
}

/** 把“当前选中模型”写回用户配置文件（模型管理用）。 */
export function saveModelSelection(selection) {
  const current = readJson(CONFIG_FILE, null) || readJson(path.join(LEGACY_CONFIG_DIR, 'config.json'), null) || {}
  const next = deepMerge(current, { models: selection })
  writeJson(CONFIG_FILE, next)
  return next
}

export function readRuntime(config) {
  return readJson(config.runtimeFile, null)
}

export function writeRuntime(config, value) {
  return writeJson(config.runtimeFile, { ...value, updatedAt: new Date().toISOString() })
}

export function clearRuntime(config) {
  try {
    fs.rmSync(config.runtimeFile, { force: true })
  } catch {
    /* 忽略 */
  }
}

export function describeConfig(config) {
  return [
    `comfy.mode=${config.comfy.mode}`,
    `baseUrl=${config.baseUrl || '(auto)'}`,
    `ports=${config.comfy.portCandidates.join('/')}`,
    `unet=${config.models.unet}`,
    `clip=${config.models.clip}`
  ].join(' ')
}
