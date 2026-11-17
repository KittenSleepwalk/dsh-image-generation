/**
 * 环境体检：权重文件 / ComfyUI 状态 / 节点 / 模型列表 / 端口 / 本地模型清单。
 * 运行：node scripts/doctor.mjs
 */

import fs from 'node:fs'
import path from 'node:path'

import { CONFIG_FILE, CONFIG_DIR, LOG_DIR, resolveConfig, readRuntime } from '../lib/config.js'
import { ComfyClient, systemSummary } from '../lib/comfy.js'
import { healthAt, isPortFree, ownedInfo } from '../lib/server.js'
import { listLocalModels, modelsRoot } from '../lib/models.js'

const config = resolveConfig({})
const root = modelsRoot(config)

const ROLE_FOLDER = {
  unet: 'diffusion_models',
  unetTurbo: 'diffusion_models',
  clip: 'text_encoders',
  clipLean: 'text_encoders',
  vae: 'vae'
}
const problems = []
const warnings = []

function line(ok, text) {
  console.log(`  [${ok}] ${text}`)
}

console.log('dsh-image-generation-ks doctor')
console.log(`  config     : ${CONFIG_FILE}${fs.existsSync(CONFIG_FILE) ? '' : ' (不存在，使用默认值/旧插件配置)'}`)
console.log(`  config dir : ${CONFIG_DIR}`)
console.log(`  comfy root : ${config.comfy.cwd}`)
console.log(`  models     : ${root}`)
console.log(`  api prefix : ${config.apiPath}`)
console.log(`  mode       : ${config.comfy.mode}   portCandidates=${config.comfy.portCandidates.join('/')}`)
console.log(`  runtime    : ${config.runtimeFile}${fs.existsSync(config.runtimeFile) ? ' (存在)' : ''}`)
console.log(`  logs       : ${LOG_DIR}`)

console.log('\n== selected models ==')
for (const [role, folder] of Object.entries(ROLE_FOLDER)) {
  const name = config.models[role]
  const file = path.join(root, folder, name || '')
  if (!name) {
    line(' ?? ', `${role}: 未设置`)
    continue
  }
  if (!fs.existsSync(file)) {
    line('MISS', `${role}: ${folder}/${name}`)
    problems.push(`${folder}/${name}`)
    continue
  }
  const size = fs.statSync(file).size
  line(' OK ', `${role}: ${folder}/${name}  ${(size / 1024 ** 3).toFixed(2)} GB`)
}

console.log('\n== local inventory ==')
const local = listLocalModels(config)
console.log(`  共 ${local.items.length} 个权重文件`)
for (const item of local.items) {
  console.log(`    ${item.folder}/${item.name}  ${item.sizeGb}GB${item.selected ? '  [使用中: ' + item.selectedFor.join(',') + ']' : ''}`)
}

console.log('\n== comfyui ==')
let baseUrl = config.baseUrl
let stats = await healthAt(baseUrl)
if (!stats) {
  for (const port of config.comfy.portCandidates) {
    const candidate = `http://127.0.0.1:${port}`
    const found = await healthAt(candidate)
    if (found) {
      stats = found
      baseUrl = candidate
      break
    }
  }
}
const runtime = readRuntime(config)
if (stats) {
  const summary = systemSummary(stats)
  line(' OK ', `reachable ${baseUrl}  v${summary.comfyuiVersion}  torch=${summary.torchVersion}`)
  line(' OK ', `gpu=${summary.deviceName}  vram=${summary.vramTotalMb}MB (free ${summary.vramFreeMb}MB)`)
} else {
  line('MISS', 'ComfyUI 未运行（首次出图时插件会自动拉起）')
  console.log(`       手动启动： "${config.comfy.python}" "${config.comfy.main}" --port ${config.comfy.portCandidates[0]} --listen 127.0.0.1`)
}
if (runtime) console.log(`  runtime.json: port=${runtime.port} pid=${runtime.pid || '-'} startedByUs=${runtime.startedByUs}`)
const owned = ownedInfo()
if (owned) console.log(`  owned child : pid=${owned.pid} port=${owned.port}`)

console.log('\n== ports ==')
for (const port of config.comfy.portCandidates) {
  const free = await isPortFree(port)
  const health = free ? null : await healthAt(`http://127.0.0.1:${port}`)
  line(free ? 'free' : health ? 'comfy' : 'busy', `${port}${free ? '' : health ? ' (ComfyUI)' : ' (其它程序)'}`)
}

if (stats) {
  console.log('\n== nodes ==')
  const client = new ComfyClient(baseUrl)
  for (const node of ['TextEncodeQwenImage21', 'QwenImage21Cache', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'KSampler', 'VAEDecode']) {
    const info = await client.objectInfo(node).catch(() => null)
    const ok = Boolean(info && info[node])
    line(ok ? ' OK ' : 'MISS', node)
    if (!ok) problems.push(`node ${node}`)
  }

  console.log('\n== model lists ==')
  const clipInfo = await client.objectInfo('CLIPLoader').catch(() => null)
  const required = (clipInfo && clipInfo.CLIPLoader && clipInfo.CLIPLoader.input && clipInfo.CLIPLoader.input.required) || {}
  const clipTypes = (required.type && required.type[0]) || []
  line(clipTypes.includes('qwen_image') ? ' OK ' : 'MISS', 'CLIPLoader type 含 qwen_image')
  if (!clipTypes.includes('qwen_image')) problems.push('clip type qwen_image')

  const unetInfo = await client.objectInfo('UNETLoader').catch(() => null)
  const unetReq = (unetInfo && unetInfo.UNETLoader && unetInfo.UNETLoader.input && unetInfo.UNETLoader.input.required) || {}
  const unets = (unetReq.unet_name && unetReq.unet_name[0]) || (unetReq.ckpt_name && unetReq.ckpt_name[0]) || []
  for (const role of ['unet', 'unetTurbo']) {
    const name = config.models[role]
    if (!name) continue
    const ok = unets.includes(name)
    line(ok ? ' OK ' : 'MISS', `${role}: diffusion_models/${name}`)
    if (!ok) warnings.push(`${name} 不在 ComfyUI 列表（下载后需要重启 ComfyUI 扫描模型目录）`)
  }
  const clips = (required.clip_name && required.clip_name[0]) || []
  for (const role of ['clip', 'clipLean']) {
    const name = config.models[role]
    if (!name) continue
    const ok = clips.includes(name)
    line(ok ? ' OK ' : 'MISS', `${role}: text_encoders/${name}`)
    if (!ok) warnings.push(`${name} 不在 ComfyUI 列表`)
  }
}

console.log('\n== summary ==')
if (problems.length === 0) console.log('  all good')
else {
  console.log(`  problems: ${problems.length}`)
  for (const item of problems) console.log(`   - ${item}`)
}
for (const item of warnings) console.log(`  warning: ${item}`)

process.exit(problems.length ? 1 : 0)
