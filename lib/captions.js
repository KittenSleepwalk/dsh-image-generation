/** 文本框/气泡框组装：调用 scripts/assemble_captions.py，把底案图变成「底案 + 文字版 + captions.json」。 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from './config.js'
import { renderFailureText } from './result.js'
import { logDebug } from './log.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.resolve(HERE, '..', 'scripts', 'assemble_captions.py')

/** 找可用的 python：优先 ComfyUI venv */
export function resolvePython(config) {
  const candidates = [
    process.env.DSH_IMAGE_PYTHON,
    config && config.comfy && config.comfy.cwd ? path.join(config.comfy.cwd, '.venv', 'Scripts', 'python.exe') : '',
    config && config.comfy && config.comfy.cwd ? path.join(config.comfy.cwd, '.venv', 'bin', 'python') : '',
    'python'
  ].filter(Boolean)
  return candidates.find((candidate) => candidate === 'python' || fs.existsSync(candidate)) || 'python'
}

/**
 * 规划标签位置：title 在顶部；label 按锚点分左右侧纵向均分；无锚点时右侧分布。
 * @returns {{text:string,shape:string,side:string,anchor:[number,number]}[]}
 */
export function planCaptionBoxes(labels) {
  const list = (labels || []).map((item) => (typeof item === 'string' ? { text: item } : { ...item })).filter((item) => item.text)
  const providedTitle = list.find((item) => item.shape === 'title')
  const providedFooter = list.find((item) => item.shape === 'footer')
  const middles = list.filter((item) => item.shape !== 'title' && item.shape !== 'footer')
  const planned = []
  if (providedTitle) planned.push({ text: providedTitle.text, shape: 'title', side: 'left', anchor: [0.08, 0.08], color: providedTitle.color })
  else if (list.length) planned.push({ text: list[0].text, shape: 'title', side: 'left', anchor: [0.08, 0.08], color: list[0].color })
  middles.forEach((item, index) => {
    const y = middles.length === 1 ? 0.5 : 0.24 + (0.52 * index) / (middles.length - 1)
    const side = item.side || 'right'
    planned.push({
      text: item.text,
      shape: item.shape || 'label',
      side,
      anchor: item.anchor || [side === 'right' ? 0.62 : 0.38, y],
      color: item.color
    })
  })
  if (providedFooter) planned.push({ text: providedFooter.text, shape: 'footer', color: providedFooter.color })
  else if (list.length > 1) planned.push({ text: list[list.length - 1].text, shape: 'footer' })
  return planned
}

/**
 * 组装：底案图 + 标签 -> 底案/文字版/manifest
 * @returns {Promise<{basePath:string,textPath:string,manifestPath:string,boxes:object[]}>}
 */
export async function runCaptionAssembly(options) {
  const config = resolveConfig(options.config || {})
  const python = options.python || resolvePython(config)
  if (!fs.existsSync(SCRIPT)) throw new Error('找不到 assemble_captions.py：' + SCRIPT)
  if (!options.baseImage || !fs.existsSync(options.baseImage)) throw new Error('底案图不存在：' + options.baseImage)
  const labels = Array.isArray(options.labels) && options.labels.length ? options.labels : planCaptionBoxes(options.rawLabels || [])
  const outDir = options.outputDir || path.dirname(options.baseImage)
  const basename = options.basename || path.basename(options.baseImage, path.extname(options.baseImage))
  const job = {
    base: path.resolve(options.baseImage),
    out_dir: path.resolve(outDir),
    basename,
    labels,
    font: 'C:/Windows/Fonts/msyh.ttc',
    font_bold: 'C:/Windows/Fonts/msyhbd.ttc'
  }
  const jobFile = path.join(os.tmpdir(), `ks-captions-${Date.now()}.json`)
  fs.writeFileSync(jobFile, JSON.stringify(job), 'utf8')
  logDebug('captions', { python, base: job.base, labels: labels.length })
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(python, [SCRIPT, '--job', jobFile], { timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }, (error, out) => {
        if (error) reject(error)
        else resolve(String(out || ''))
      })
    })
    const parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop())
    if (!parsed.ok) throw new Error(parsed.error || '组装失败')
    return { basePath: parsed.base, textPath: parsed.text, manifestPath: parsed.manifest, boxes: parsed.boxes || [] }
  } finally {
    try { fs.unlinkSync(jobFile) } catch (error) { /* ignore */ }
  }
}

export function formatCaptionResult(result) {
  const lines = [`已组装 ${result.boxes.length} 个文本框/气泡框：`]
  lines.push(`  底案（无文字）：${result.basePath}`)
  lines.push(`  文字版：${result.textPath}`)
  lines.push(`  框位清单：${result.manifestPath}`)
  lines.push('  文字框位置/字号/颜色记录在 captions.json 里，PPT/PS 可直接按坐标回填或二次编辑。')
  return lines.join('\n')
}

export { SCRIPT as CAPTION_SCRIPT }
