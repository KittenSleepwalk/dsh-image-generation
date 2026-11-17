/** 输出文件规划：绝不覆盖已有文件，文件名带时间戳与 seed，方便复现。 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDir, expandHome } from './config.js'

const IMAGE_EXT = ['.png', '.webp', '.jpg', '.jpeg']

export function timestamp(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

export function isImagePath(value) {
  return IMAGE_EXT.includes(path.extname(String(value || '')).toLowerCase())
}

/**
 * @param {object} input
 * @param {string} input.outputPath  用户给的文件或目录（可空）
 * @param {string} input.cwd         会话工作目录
 * @param {string} input.defaultDir  配置里的 outputDir（可空）
 * @param {number} input.seed
 * @returns {{file: string, dir: string}}
 */
export function planOutput(input) {
  const { outputPath, cwd, defaultDir, seed } = input
  const stamp = timestamp()
  const baseName = `${stamp}-${seed}`

  let dir
  let file
  const given = expandHome(String(outputPath || '').trim())
  if (given) {
    const abs = path.isAbsolute(given) ? given : path.resolve(cwd, given)
    if (isImagePath(abs)) {
      dir = path.dirname(abs)
      file = abs
    } else {
      dir = abs
      file = path.join(dir, `${baseName}.png`)
    }
  } else {
    dir = defaultDir
      ? path.isAbsolute(defaultDir)
        ? defaultDir
        : path.resolve(cwd, defaultDir)
      : path.join(cwd, 'gen')
    file = path.join(dir, `${baseName}.png`)
  }

  ensureDir(dir)
  return { file: uniquePath(file), dir }
}

export function uniquePath(file) {
  if (!fs.existsSync(file)) return file
  const ext = path.extname(file)
  const stem = file.slice(0, file.length - ext.length)
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${stem}-${i}${ext}`
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new Error(`无法为 ${file} 找到不冲突的文件名`)
}

export function writeSidecar(imageFile, payload) {
  const sidecar = `${imageFile}.json`
  fs.writeFileSync(sidecar, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8' })
  return sidecar
}

/** markdown 里可用的绝对路径（正斜杠 + file:// 前缀）。 */
export function toFileUrl(file) {
  const normalized = path.resolve(file).replace(/\\/g, '/')
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${prefixed.split('/').map((part) => encodeURIComponent(part)).join('/')}`
}

export function toForwardSlash(file) {
  return path.resolve(file).replace(/\\/g, '/')
}

export function homeRelative(file) {
  const home = os.homedir()
  const abs = path.resolve(file)
  return abs.startsWith(home) ? `~${abs.slice(home.length)}` : abs
}
