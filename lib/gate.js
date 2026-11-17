/** 产物门禁：只判“明显坏了”，语义正确性交给人或 Agent 看图。 */

import fs from 'node:fs'

const PNG_SIGNATURE = '89504e470d0a1a0a'

/** 只读 PNG 头部 33 字节，不解码像素（零依赖）。 */
export function pngInfo(buffer) {
  if (!buffer || buffer.length < 33) return { ok: false, reason: '文件太小，不是完整 PNG' }
  if (buffer.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) return { ok: false, reason: '不是 PNG 文件' }
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  const bitDepth = buffer[24]
  const colorType = buffer[25]
  return {
    ok: true,
    width,
    height,
    bitDepth,
    colorType,
    alpha: colorType === 4 || colorType === 6,
    bytes: buffer.length
  }
}

/**
 * @param {string} filePath
 * @param {object} expect {width, height, expectAlpha}
 * @returns {{passed: boolean, checks: object[]}}
 */
export function gateImage(filePath, expect = {}) {
  const checks = []
  let info = { ok: false }
  let size = 0
  try {
    size = fs.statSync(filePath).size
    info = pngInfo(fs.readFileSync(filePath))
  } catch (error) {
    return {
      passed: false,
      checks: [{ name: 'readable', ok: false, detail: error.message }]
    }
  }

  checks.push({ name: 'png_header', ok: info.ok, detail: info.ok ? `${info.width}x${info.height}` : info.reason })
  checks.push({ name: 'file_size', ok: size > 8 * 1024, detail: `${size} bytes` })
  if (info.ok && expect.width) {
    checks.push({
      name: 'width_match',
      ok: info.width === expect.width,
      detail: `${info.width} vs ${expect.width}`
    })
  }
  if (info.ok && expect.height) {
    checks.push({
      name: 'height_match',
      ok: info.height === expect.height,
      detail: `${info.height} vs ${expect.height}`
    })
  }
  if (info.ok && expect.expectAlpha) {
    checks.push({
      name: 'alpha_channel',
      ok: info.alpha === true,
      detail: info.alpha ? `colorType=${info.colorType}` : `colorType=${info.colorType}（没有 alpha 通道）`
    })
  }

  return { passed: checks.every((check) => check.ok), checks, info, size }
}

export function summarizeGate(gate) {
  if (!gate) return '未校验'
  if (gate.passed) return '通过'
  const failed = (gate.checks || []).filter((check) => !check.ok).map((check) => check.name)
  return `未通过（${failed.join(', ')}）`
}
