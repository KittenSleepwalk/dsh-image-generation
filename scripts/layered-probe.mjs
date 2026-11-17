/**
 * 拆层探针：拿一张已经画好的图，跑 Qwen-Image-Layered，量"拆完能不能合回去"。
 *
 *   node scripts/layered-probe.mjs <图片> [--layers 4] [--check] [--out 目录]
 *
 * --check 只校验工作流里的节点和参数在目标 ComfyUI 上是否存在（不占显存）。
 * 不带 --check 才会真的跑：拆层 → 下载每层 → 合成 → 和原图比 PSNR / SSIM。
 */

import fs from 'node:fs'
import path from 'node:path'

import { COMFY_ROOT, resolveConfig } from '../lib/config.js'
import { ComfyClient } from '../lib/comfy.js'
import { buildLayeredWorkflow, fitSize, runLayered, stageInput } from '../lib/layered.js'
import { ensureServer } from '../lib/server.js'
import { decodePng } from '../lib/png.js'

function parseArgs(argv) {
  const args = { layers: 4, max: 640, steps: 20, cfg: 2.5, check: false }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--check') args.check = true
    else if (token === '--layers') args.layers = Number(argv[(i += 1)])
    else if (token === '--max') args.max = Number(argv[(i += 1)])
    else if (token === '--steps') args.steps = Number(argv[(i += 1)])
    else if (token === '--cfg') args.cfg = Number(argv[(i += 1)])
    else if (token === '--seed') args.seed = Number(argv[(i += 1)])
    else if (token === '--prompt') args.prompt = argv[(i += 1)]
    else if (token === '--out') args.out = argv[(i += 1)]
    else rest.push(token)
  }
  args.image = rest[0]
  return args
}

/** 用 ComfyUI 自己的 /object_info 校验节点与参数，不跑模型。 */
async function checkWorkflow(client, workflow) {
  const problems = []
  for (const [id, node] of Object.entries(workflow)) {
    let info
    try {
      info = await client.objectInfo(node.class_type)
    } catch {
      info = null
    }
    if (!info || !info[node.class_type]) {
      problems.push(`节点 ${node.class_type}（id=${id}）不存在`)
      continue
    }
    const spec = info[node.class_type]
    const required = Object.keys(spec.input?.required || {})
    const inputs = node.inputs || {}
    for (const name of required) {
      if (!(name in inputs)) problems.push(`${node.class_type}: 缺必填参数 ${name}`)
    }
    for (const [name, value] of Object.entries(inputs)) {
      const def = (spec.input?.required || {})[name] || (spec.input?.optional || {})[name]
      if (!Array.isArray(def)) continue
      const allowed = def[0]
      if (Array.isArray(allowed) && typeof value === 'string' && !Array.isArray(value)) {
        if (!allowed.includes(value)) problems.push(`${node.class_type}.${name}: "${value}" 不在可选值里`)
      }
    }
  }
  return problems
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.image) {
    console.error('用法：node scripts/layered-probe.mjs <图片> [--layers 4] [--check] [--out 目录]')
    process.exit(2)
  }
  const source = path.resolve(args.image)
  if (!fs.existsSync(source)) throw new Error(`找不到图片：${source}`)

  const cfg = resolveConfig()
  const server = await ensureServer(cfg, { log: (msg) => console.log('[comfy]', msg) })
  const client = new ComfyClient(server.baseUrl, { timeoutMs: 30000 })
  const stats = await client.health()
  if (!stats) throw new Error(`ComfyUI 没在 ${server.baseUrl} 上运行`)

  const image = decodePng(fs.readFileSync(source))
  const size = fitSize(image.width, image.height, args.max)
  const staged = stageInput(COMFY_ROOT, source)
  const workflow = buildLayeredWorkflow({
    imageName: staged.name,
    width: size.width,
    height: size.height,
    layers: args.layers,
    prompt: args.prompt || '',
    seed: args.seed || 20261106,
    steps: args.steps,
    cfg: args.cfg
  })

  const problems = await checkWorkflow(client, workflow)
  if (problems.length) {
    console.log('工作流校验失败：')
    for (const p of problems) console.log('  -', p)
    process.exit(1)
  }
  console.log(`工作流校验通过：${Object.keys(workflow).length} 个节点，输出 ${size.width}×${size.height}，${args.layers} 层`)
  if (args.check) process.exit(0)

  const result = await runLayered(client, {
    sourceFile: source,
    comfyRoot: COMFY_ROOT,
    layers: args.layers,
    prompt: args.prompt || '',
    seed: args.seed || 20261106,
    steps: args.steps,
    cfg: args.cfg,
    maxDimension: args.max,
    outDir: args.out ? path.resolve(args.out) : undefined,
    onTick: (now) => {
      if (now % 15000 < 1200) console.log('  等采样…', Math.round((now % 1000000) / 1000), 's')
    }
  })

  console.log('')
  console.log(`拆层完成：${result.metrics.count} 层，${(result.metrics.elapsedMs / 1000).toFixed(1)}s`)
  console.log(`合成还原度：PSNR ${result.metrics.psnr.toFixed(2)} dB，SSIM ${result.metrics.ssim.toFixed(4)}`)
  for (const item of result.bounds) {
    const b = item.box
    console.log(`  layer-${item.index}: ${b.width}×${b.height} @ (${b.x},${b.y})${item.empty ? ' [空层]' : ''}`)
  }
  console.log(`输出目录：${result.dir}`)
  fs.writeFileSync(
    path.join(result.dir, 'metrics.json'),
    JSON.stringify({ metrics: result.metrics, bounds: result.bounds }, null, 2)
  )
  process.exit(0)
}

main().catch((error) => {
  console.error('失败：', error.message)
  process.exit(1)
})
