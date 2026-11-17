/** 结果整形：给 Agent 的文本 + 结构化字段。 */

import { toFileUrl, toForwardSlash } from './files.js'
import { summarizeGate } from './gate.js'

function quotePrompt(prompt, limit = 80) {
  const text = String(prompt || '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * @param {object} run runGeneration 的返回值
 * @returns {object} 符合工具输出 schema 的对象
 */
export function formatResult(run) {
  const { request, file, files, gate, promptId, timing, models, server, resized } = run
  const seconds = (timing.totalMs / 1000).toFixed(1)
  const sizeText = `${request.width}×${request.height}`
  const alphaText = request.transparent ? '，带透明通道' : ''

  const lines = []
  lines.push(`已生成 1 张 ${sizeText} 图片${alphaText}（${request.preset.name} 档 / ${request.steps} 步 / seed ${request.seed}）`)
  lines.push(`图片：${file}`)
  lines.push(`![生成图](${toFileUrl(file)})`)
  lines.push(
    `用时 ${seconds}s（排队 ${(timing.queueMs / 1000).toFixed(1)}s + 采样 ${(timing.sampleMs / 1000).toFixed(1)}s），门禁${summarizeGate(gate)}`
  )
  if (server && server.startedByUs) lines.push('本次由插件自动启动了 ComfyUI（空闲后会自动关闭）')
  const notes = [...(request.notes || [])]
  if (resized) notes.push(`尺寸已对齐到 32 的倍数：${resized.note}`)
  if (notes.length) lines.push(`说明：${notes.join('；')}`)
  lines.push(
    `复现同一张：generate_image({ prompt: "${quotePrompt(request.prompt)}", preset: "${request.preset.name}", seed: ${request.seed} })`
  )

  return {
    text: lines.join('\n'),
    path: file,
    files,
    preset: request.preset.name,
    seed: request.seed,
    width: request.width,
    height: request.height,
    steps: request.steps,
    transparent: request.transparent === true,
    prompt_id: promptId,
    comfy_url: server && server.baseUrl ? server.baseUrl : '',
    duration_ms: timing.totalMs,
    gate: {
      passed: gate.passed === true,
      summary: summarizeGate(gate),
      checks: (gate.checks || []).map((check) => `${check.name}:${check.ok ? 'ok' : 'fail'}`)
    },
    models,
    success: gate.passed === true
  }
}

/** 失败时的文本：错误 + 怎么办，尽量让 Agent 能自己纠正。 */
export function renderFailureText(error, hint = '') {
  const message = error && error.message ? error.message : String(error)
  const advice = (error && error.hint) || hint
  return advice ? `${message}\n怎么办：${advice}` : message
}

export function markdownImage(file) {
  return `![生成图](${toFileUrl(file)})`
}

export function plainPath(file) {
  return toForwardSlash(file)
}
