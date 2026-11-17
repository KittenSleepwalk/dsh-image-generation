/**
 * 调 Windows 自带中文 OCR 生成文字遮罩（运行 prep-text-masks.ps1）。
 * 输出：docs/_masks/<参考图名>.png（白=需重绘）、docs/ocr.json（识别文字）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const docsDir = path.resolve(process.argv[2] || path.join(pluginRoot, 'docs'))
const maskDir = path.join(docsDir, '_masks')
fs.mkdirSync(maskDir, { recursive: true })

const refs = fs
  .readdirSync(docsDir)
  .filter((name) => /^参考图（.+）\.(png|jpg|jpeg)$/i.test(name))
  .map((name) => path.join(docsDir, name))
if (!refs.length) {
  console.error('没有找到参考图')
  process.exit(1)
}

const listFile = path.join(maskDir, '_list.json')
fs.writeFileSync(listFile, JSON.stringify(refs, null, 2), 'utf8')

const ps1 = path.join(here, 'prep-text-masks.ps1')
const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-DocsDir', docsDir, '-MaskDir', maskDir, '-ListFile', listFile], { encoding: 'utf8', timeout: 300000 })
console.log(result.stdout || '')
if (result.stderr) console.error(result.stderr)
if (result.status !== 0) process.exit(result.status || 1)

const ocr = JSON.parse(fs.readFileSync(path.join(docsDir, 'ocr.json'), 'utf8').replace(/^\uFEFF/, ''))
const list = Array.isArray(ocr) ? ocr : [ocr]
console.log(JSON.stringify({ masks: list.length, words: list.reduce((sum, item) => sum + item.wordCount, 0) }, null, 2))
