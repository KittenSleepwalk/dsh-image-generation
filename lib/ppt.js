/** 底案 → 可编辑 PPTX（对齐参考样例：白色圆角标注 + 彩色边框 + 圆点虚线引导 + 底部结论条）。 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from './config.js'
import { resolvePython } from './captions.js'
import { logDebug } from './log.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.resolve(HERE, '..', 'scripts', 'export_ppt.py')
const ASSET_SCRIPT = path.resolve(HERE, '..', 'scripts', 'make_callout_assets.py')
const ASSET_MANIFEST = path.resolve(HERE, '..', 'assets', 'callouts', 'manifest.json')
export { SCRIPT as PPT_SCRIPT }

/** 确保气泡框素材存在（透明 PNG，框外无底色，可在 PPT 里拉伸） */
export async function ensureCalloutAssets(python) {
  if (fs.existsSync(ASSET_MANIFEST)) return ASSET_MANIFEST
  await new Promise((resolve, reject) => {
    execFile(python, [ASSET_SCRIPT], { timeout: 60000, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
  return ASSET_MANIFEST
}

/**
 * @param {object} options
 * @param {string} options.baseImage 底案图
 * @param {Array} options.labels [{text, shape:'callout'|'footer', side, anchor:[x,y], color}]
 * @param {string} [options.outputPath] 输出目录
 * @param {string} [options.basename] 输出文件名（不含扩展名）
 */
export async function runExportPpt(options) {
  const config = resolveConfig(options.config || {})
  const python = options.python || resolvePython(config)
  if (!fs.existsSync(SCRIPT)) throw new Error('找不到 export_ppt.py：' + SCRIPT)
  if (!options.baseImage || !fs.existsSync(options.baseImage)) throw new Error('底案图不存在：' + options.baseImage)
  const outDir = options.outputPath || path.dirname(options.baseImage)
  const basename = options.basename || path.basename(options.baseImage, path.extname(options.baseImage)) + '_标注版'
  fs.mkdirSync(outDir, { recursive: true })
  const outPptx = path.join(outDir, basename + '.pptx')
  const job = {
    base: path.resolve(options.baseImage),
    out: path.resolve(outPptx),
    slide_w: Number(options.slideWidth) || 1280,
    slide_h: Number(options.slideHeight) || 720,
    font: '微软雅黑',
    labels: (options.labels || []).map((item) => ({
      text: item.text,
      shape: item.shape || 'callout',
      side: item.side || 'left',
      color: item.color,
      anchor: item.anchor
    }))
  }
  await ensureCalloutAssets(python)
  const jobFile = path.join(os.tmpdir(), `ks-ppt-${Date.now()}.json`)
  fs.writeFileSync(jobFile, JSON.stringify(job), 'utf8')
  logDebug('ppt-export', { python, labels: job.labels.length })
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(python, [SCRIPT, '--job', jobFile], { timeout: 180000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }, (error, out) => {
        if (error) reject(error)
        else resolve(String(out || ''))
      })
    })
    const parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop())
    if (!parsed.ok) throw new Error(parsed.error || 'PPT 导出失败')
    return { pptxPath: parsed.pptx, slide: parsed.slide, boxes: parsed.boxes || [], footer: parsed.footer }
  } finally {
    try { fs.unlinkSync(jobFile) } catch (error) { /* ignore */ }
  }
}

export function formatPptResult(result) {
  return [
    `已导出可编辑 PPT：${result.pptxPath}`,
    `  画布：${result.slide[0]}×${result.slide[1]}，标注 ${result.boxes.length} 个${result.footer ? ' + 底部结论条' : ''}`,
    '  文字与文字框全部由 PPT 生成：气泡框/标注框是透明 PNG 素材（框外无底色，可随意拉伸），文字是 PPT 原生文本框，可直接改字/字号/颜色。',
    '  引导线是 PPT 原生圆点虚线；PPTX 原件已保存，调好版后截图即为文字版。'
  ].join('\n')
}
