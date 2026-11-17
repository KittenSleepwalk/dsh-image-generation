/**
 * 端到端冒烟（不依赖 DSH、不依赖插件被加载）：
 *   node scripts/e2e-once.mjs
 *   node scripts/e2e-once.mjs --prompt "一只赛璐璐风格的柯基宇航员" --preset fast --out C:\temp\gen
 *
 * 它会走完整链路：配置解析 → 自动拉起/复用 ComfyUI → 校验模型与节点 → 提交工作流
 * → 轮询 → 取回 PNG → 门禁 → 写 sidecar，并打印结果文本。
 */

import path from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { runGeneration } from '../lib/runner.js'
import { formatResult } from '../lib/result.js'

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const config = resolveConfig({})
const prompt = arg('prompt', '一只戴着头盔的柯基宇航员，赛璐璐风格插画，粗黑描边，硬边平涂，纯色背景')
const preset = arg('preset', 'fast')
const outputPath = arg('out', path.join(process.cwd(), 'gen'))

console.log(`[e2e] prompt = ${prompt}`)
console.log(`[e2e] preset = ${preset}  out = ${outputPath}`)

try {
  const run = await runGeneration({
    args: { prompt, preset, output_path: outputPath },
    cwd: process.cwd(),
    config,
    log: (message) => console.log(`[e2e] ${message}`)
  })
  const result = formatResult(run)
  console.log('')
  console.log(result.text)
  console.log('')
  console.log(
    JSON.stringify(
      {
        path: result.path,
        preset: result.preset,
        seed: result.seed,
        size: `${result.width}x${result.height}`,
        steps: result.steps,
        duration_ms: result.duration_ms,
        gate: result.gate,
        models: result.models,
        comfy_url: result.comfy_url
      },
      null,
      2
    )
  )
  // 主动退出：ComfyUI 子进程与 keep-alive 连接会让事件循环挂着，CLI 不该等它们
  process.exit(0)
} catch (error) {
  console.error('')
  console.error(`[e2e] FAILED: ${error.message}`)
  if (error.hint) console.error(`[e2e] 怎么办：${error.hint}`)
  process.exit(1)
}
