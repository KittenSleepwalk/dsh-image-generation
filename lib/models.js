/**
 * 模型管理（纯静态逻辑，不依赖任何 LLM）：
 *   - 扫描本地 ComfyUI models 目录，列出可用模型与当前选中项
 *   - 关键词搜索 ModelScope / HuggingFace 的模型仓库（公开 HTTP API）
 *   - 列出某仓库某目录下的权重文件，给出下载地址
 *   - 下载（断点续传 + 大小校验）、删除、切换选中
 *
 * 设计原则：本地文件系统操作一律做路径越界检查；网络失败只返回错误，不抛异常。
 */

import fs from 'node:fs'
import path from 'node:path'

import { ensureDir, saveModelSelection } from './config.js'
import { ImagePluginError, CODES } from './errors.js'

/** role → ComfyUI 子目录 */
export const ROLE_FOLDERS = {
  unet: 'diffusion_models',
  unetTurbo: 'diffusion_models',
  clip: 'text_encoders',
  clipLean: 'text_encoders',
  vae: 'vae'
}

/** role 的中文说明（给工具/界面展示） */
export const ROLE_LABELS = {
  unet: '主 DiT（标准/质量档）',
  unetTurbo: 'turbo DiT（极速档）',
  clip: '文本编码器 int8（画质基准）',
  clipLean: '文本编码器 w4a8（省显存）',
  vae: 'VAE（RGBA 解码）'
}

/** 目录 → 可承担的角色（反查用） */
const FOLDER_ROLES = {
  diffusion_models: ['unet', 'unetTurbo'],
  text_encoders: ['clip', 'clipLean'],
  vae: ['vae']
}

const WEIGHT_EXT = /\.(safetensors|gguf|pt|pth|bin|ckpt)$/i
export const MAX_DOWNLOAD_BYTES = 60 * 1024 ** 3

/** HuggingFace 直连常被墙：优先国内镜像 hf-mirror，再回退官方域名。 */
export const HF_BASE_URLS = ['https://hf-mirror.com', 'https://huggingface.co']

export function modelsRoot(config) {
  return path.join(config.comfy.cwd, 'models')
}

export function folderForRole(role) {
  const folder = ROLE_FOLDERS[role]
  if (!folder) {
    throw new ImagePluginError(
      CODES.BAD_ARGS,
      `未知模型角色 role=${role}`,
      `可选：${Object.keys(ROLE_FOLDERS).join(' / ')}`
    )
  }
  return folder
}

function humanGb(bytes) {
  return Number((Number(bytes || 0) / 1024 ** 3).toFixed(2))
}

/** 本地模型清单：按目录去重，标出该文件可充当哪些角色、当前选中了哪些角色。 */
export function listLocalModels(config) {
  const root = modelsRoot(config)
  const items = []
  for (const [folder, roles] of Object.entries(FOLDER_ROLES)) {
    const dir = path.join(root, folder)
    if (!fs.existsSync(dir)) continue
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !WEIGHT_EXT.test(entry.name)) continue
      const file = path.join(dir, entry.name)
      let stat
      try {
        stat = fs.statSync(file)
      } catch {
        continue
      }
      const selectedFor = roles.filter((role) => config.models[role] === entry.name)
      items.push({
        folder,
        name: entry.name,
        sizeGb: humanGb(stat.size),
        bytes: stat.size,
        path: file,
        roles,
        selectedFor,
        selected: selectedFor.length > 0
      })
    }
  }
  items.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name))
  const selected = {}
  for (const role of Object.keys(ROLE_FOLDERS)) selected[role] = config.models[role] || null
  return { root, items, selected }
}

/** 切换某个角色使用的模型文件（写入 ~/.dsh-image-generation-ks/config.json）。 */
export function selectModel(config, role, name) {
  const folder = folderForRole(role)
  if (!name || typeof name !== 'string') {
    throw new ImagePluginError(CODES.BAD_ARGS, '缺少模型文件名 name', '先用 list 看本地有哪些文件')
  }
  const file = path.join(modelsRoot(config), folder, path.basename(name))
  if (!fs.existsSync(file)) {
    throw new ImagePluginError(
      CODES.MISSING_MODEL,
      `本地没有这个文件：${folder}/${name}`,
      '先用 action=list 看本地清单；没有就先 action=search 找到仓库再 download'
    )
  }
  saveModelSelection({ [role]: path.basename(name) })
  const next = { ...config, models: { ...config.models, [role]: path.basename(name) } }
  return { role, name: path.basename(name), folder, selected: next.models[role] }
}

/** 删除本地模型文件（拒绝删当前选中项、拒绝越界路径）。 */
export function deleteModel(config, role, name) {
  if (config.models.allowDelete === false) {
    throw new ImagePluginError(CODES.BAD_ARGS, '配置里禁止删除模型（models.allowDelete=false）', '改配置后再试')
  }
  const folder = folderForRole(role)
  const root = path.resolve(modelsRoot(config))
  const target = path.resolve(root, folder, path.basename(name))
  if (!target.startsWith(root + path.sep)) {
    throw new ImagePluginError(CODES.BAD_ARGS, `路径越界，拒绝删除：${target}`, '只能删 models 目录内的文件')
  }
  if (!fs.existsSync(target)) {
    throw new ImagePluginError(CODES.MISSING_MODEL, `文件不存在：${folder}/${name}`, '刷新列表确认名字')
  }
  const selectedRoles = Object.entries(ROLE_FOLDERS)
    .filter(([roleKey, folderName]) => folderName === folder && config.models[roleKey] === path.basename(name))
    .map(([roleKey]) => roleKey)
  if (selectedRoles.length) {
    throw new ImagePluginError(
      CODES.BAD_ARGS,
      `该文件正被使用：${selectedRoles.join(', ')}`,
      '先把这些角色切到别的模型（action=select），再删'
    )
  }
  const bytes = fs.statSync(target).size
  fs.rmSync(target, { force: true })
  // 顺手清掉可能残留的 .part
  try {
    fs.rmSync(`${target}.part`, { force: true })
  } catch {
    /* 忽略 */
  }
  return { deleted: `${folder}/${path.basename(name)}`, freedGb: humanGb(bytes) }
}

function normalizeRepoEntry(provider, raw) {
  const id =
    raw.ModelId || raw.model_id || raw.id || raw.Path || raw.path || raw.Name || raw.name || ''
  const name = raw.Name || raw.name || String(id).split('/').pop() || String(id)
  const downloads = Number(raw.Downloads || raw.downloads || raw.DownloadCount || 0) || 0
  const likes = Number(raw.Stars || raw.Likes || raw.likes || 0) || 0
  const url =
    provider === 'modelscope'
      ? `https://www.modelscope.cn/models/${id}`
      : `https://huggingface.co/${id}`
  return { provider, id: String(id), name: String(name), downloads, likes, url }
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'dsh-image-generation-ks/0.2',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      },
      signal: controller.signal
    })
    const text = await response.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { ok: response.ok, status: response.status, json, text }
  } finally {
    clearTimeout(timer)
  }
}

/** 从各种可能的响应结构里挖出模型数组（ModelScope 的字段随版本变过）。 */
function pickModelArray(json) {
  if (!json) return []
  const candidates = [
    json.Data && json.Data.Models,
    json.Data && json.Data.Model && json.Data.Model.Models,
    json.data && json.data.models,
    json.data && json.data.Models,
    json.Models,
    json.models,
    Array.isArray(json.Data) ? json.Data : null,
    Array.isArray(json.data) ? json.data : null
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate
  }
  return []
}

async function searchModelScope(keyword, limit) {
  const body = JSON.stringify({
    PageSize: limit,
    PageNumber: 1,
    Name: keyword,
    SortBy: 'Default',
    Target: '',
    SingleCriterion: []
  })
  const attempts = [
    { url: 'https://www.modelscope.cn/api/v1/dolphin/models', options: { method: 'POST', body } },
    { url: `https://www.modelscope.cn/api/v1/models?PageNumber=1&PageSize=${limit}&Name=${encodeURIComponent(keyword)}` },
    { url: 'https://www.modelscope.cn/api/v1/models', options: { method: 'POST', body } }
  ]
  let lastError = ''
  for (const attempt of attempts) {
    try {
      const result = await fetchJson(attempt.url, attempt.options || {})
      const list = pickModelArray(result.json)
      if (list.length) {
        return { provider: 'modelscope', items: list.slice(0, limit).map((raw) => normalizeRepoEntry('modelscope', raw)) }
      }
      if (!result.ok) lastError = `HTTP ${result.status}`
    } catch (error) {
      lastError = error.message
    }
  }
  return {
    provider: 'modelscope',
    items: [],
    error:
      (lastError || '没有解析到结果') +
      '（ModelScope 的关键词搜索接口需要登录，公开接口只剩仓库详情/文件列表；关键词搜索请用 provider=huggingface，会自动走 hf-mirror 镜像）'
  }
}

async function searchHuggingFace(keyword, limit) {
  const errors = []
  for (const base of HF_BASE_URLS) {
    try {
      const result = await fetchJson(
        `${base}/api/models?search=${encodeURIComponent(keyword)}&limit=${limit}&sort=downloads`
      )
      if (Array.isArray(result.json)) {
        return {
          provider: 'huggingface',
          base,
          items: result.json.slice(0, limit).map((raw) => normalizeRepoEntry('huggingface', raw))
        }
      }
      errors.push(`${base} HTTP ${result.status}`)
    } catch (error) {
      errors.push(`${base} ${error.message}`)
    }
  }
  return { provider: 'huggingface', items: [], error: errors.join('；') || 'HuggingFace 不可达' }
}

/**
 * 关键词搜索模型仓库。
 * @returns {{results: object[], errors: string[]}}
 */
export async function searchRemoteModels(config, keyword, options = {}) {
  const text = String(keyword || '').trim()
  if (!text) {
    throw new ImagePluginError(CODES.BAD_ARGS, '缺少搜索关键词 keyword', '例如 keyword="qwen-image"')
  }
  const limit = Math.min(50, Math.max(1, Number(options.limit) || 10))
  const providers = options.provider ? [options.provider] : config.models.searchProviders || ['modelscope']
  const results = []
  const errors = []
  for (const provider of providers) {
    let result
    if (provider === 'modelscope') result = await searchModelScope(text, limit)
    else if (provider === 'huggingface') result = await searchHuggingFace(text, limit)
    else {
      errors.push(`未知来源 provider=${provider}`)
      continue
    }
    results.push(...result.items)
    if (result.error) errors.push(`${provider}: ${result.error}`)
  }
  return { keyword: text, results, errors }
}

/** 列出某仓库某目录（或全部）下的权重文件，并给出下载地址。 */
export async function listRepoFiles(config, options) {
  const provider = options.provider === 'huggingface' ? 'huggingface' : 'modelscope'
  const repo = String(options.repo || '').trim()
  if (!repo) {
    throw new ImagePluginError(CODES.BAD_ARGS, '缺少仓库名 repo', '例如 repo="Comfy-Org/Qwen-Image-2.1"')
  }
  const root = String(options.folder || '').replace(/^\/+|\/+$/g, '')
  const files = []
  if (provider === 'modelscope') {
    const url = `https://www.modelscope.cn/api/v1/models/${repo}/repo/files?Revision=master${root ? `&Root=${encodeURIComponent(root)}` : ''}`
    const result = await fetchJson(url)
    const raw = result.json && result.json.Data && result.json.Data.Files
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item.Type === 'tree') {
          files.push({ name: item.Path || item.Name, type: 'dir' })
        } else if (WEIGHT_EXT.test(item.Name || '')) {
          files.push({
            name: item.Path || item.Name,
            type: 'file',
            sizeGb: humanGb(item.Size),
            bytes: item.Size,
            url: `https://www.modelscope.cn/models/${repo}/resolve/master/${item.Path || item.Name}`
          })
        }
      }
    } else {
      throw new ImagePluginError(
        CODES.DOWNLOAD_FAILED,
        `ModelScope 仓库/目录读取失败（HTTP ${result.status}）`,
        '确认 repo 拼写正确、目录存在（例如 diffusion_models）'
      )
    }
  } else {
    const errors = []
    let listed = false
    for (const base of HF_BASE_URLS) {
      try {
        const result = await fetchJson(`${base}/api/models/${repo}/tree/main${root ? `/${root}` : ''}`)
        if (!Array.isArray(result.json)) {
          errors.push(`${base} HTTP ${result.status}`)
          continue
        }
        listed = true
        for (const item of result.json) {
          if (item.type === 'directory') {
            files.push({ name: item.path, type: 'dir' })
          } else if (WEIGHT_EXT.test(item.path || '')) {
            const size = (item.lfs && item.lfs.size) || item.size || 0
            files.push({
              name: item.path,
              type: 'file',
              sizeGb: humanGb(size),
              bytes: size,
              url: `${base}/${repo}/resolve/main/${item.path}`
            })
          }
        }
        break
      } catch (error) {
        errors.push(`${base} ${error.message}`)
      }
    }
    if (!listed) {
      throw new ImagePluginError(
        CODES.DOWNLOAD_FAILED,
        `HuggingFace 仓库/目录读取失败：${errors.join('；')}`,
        '直连与 hf-mirror 都不通时可改用 provider=modelscope（仓库文件列表公开可用）'
      )
    }
  }
  return { provider, repo, folder: root, files }
}

async function downloadToFile(url, file, options = {}) {
  const part = `${file}.part`
  let start = 0
  if (fs.existsSync(part)) start = fs.statSync(part).size
  const headers = { 'User-Agent': 'dsh-image-generation-ks/0.2' }
  if (start > 0) headers.Range = `bytes=${start}-`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), 30 * 60 * 1000)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status} ${url}`)
    }
    const total = Number(response.headers.get('content-length') || 0) + (response.status === 206 ? start : 0)
    if (total && total > MAX_DOWNLOAD_BYTES) {
      throw new Error(`文件太大（${humanGb(total)} GB），超过单次下载上限`)
    }
    const sink = fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' })
    const reader = response.body.getReader()
    let written = start
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      written += value.byteLength
      if (!sink.write(Buffer.from(value))) {
        await new Promise((resolve) => sink.once('drain', resolve))
      }
      if (options.onProgress) options.onProgress(written, total)
    }
    await new Promise((resolve, reject) => {
      sink.end((error) => (error ? reject(error) : resolve()))
    })
    if (total && written !== total) {
      throw new Error(`下载不完整：${written}/${total} 字节（.part 已保留，可重试续传）`)
    }
    fs.renameSync(part, file)
    return { file, bytes: written }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 下载一个权重文件到 ComfyUI 的对应目录（.part 续传 + 大小校验）。
 * @param {object} options {url, folder, filename, expectedBytes}
 */
export async function downloadModel(config, options) {
  const folder = String(options.folder || '').replace(/^\/+|\/+$/g, '')
  if (!FOLDER_ROLES[folder]) {
    throw new ImagePluginError(
      CODES.BAD_ARGS,
      `不支持的目录 folder=${folder}`,
      `只能是 ${Object.keys(FOLDER_ROLES).join(' / ')}（或以其结尾的文件路径）`
    )
  }
  const url = String(options.url || '').trim()
  if (!/^https?:\/\//i.test(url)) {
    throw new ImagePluginError(CODES.BAD_ARGS, '缺少可下载的 url', '先 action=files 拿到文件下载地址')
  }
  const filename = path.basename(String(options.filename || url.split('?')[0].split('/').pop() || ''))
  if (!WEIGHT_EXT.test(filename)) {
    throw new ImagePluginError(CODES.BAD_ARGS, `文件名不是权重格式：${filename}`, '只支持 safetensors / gguf / pt / pth / bin / ckpt')
  }
  const dir = path.join(modelsRoot(config), folder)
  ensureDir(dir)
  const target = path.join(dir, filename)
  if (fs.existsSync(target)) {
    const size = fs.statSync(target).size
    return { skipped: true, file: target, bytes: size, note: '文件已存在，未覆盖' }
  }
  const result = await downloadToFile(url, target, options)
  return { skipped: false, folder, filename, ...result, sizeGb: humanGb(result.bytes) }
}
