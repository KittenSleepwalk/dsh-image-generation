/**
 * 档位 = 把「显存预算 + 步数 + 模型文件」打包成一个 Agent 能理解的词。
 * Agent 不应该知道 int8/w4a8，只需要选 fast / standard / turbo / quality / transparent。
 */

/** 1MP 档（约 1024²）各比例，全部是 32 的倍数（Qwen-Image 的 16x 压缩 + 2 的整除）。 */
export const ASPECTS_1MP = {
  '1:1': [1024, 1024],
  '4:3': [1152, 864],
  '3:4': [864, 1152],
  '3:2': [1248, 832],
  '2:3': [832, 1248],
  '16:9': [1344, 768],
  '9:16': [768, 1344]
}

/** 4MP 档（官方原生 2K 比例，长边最大 2752）。 */
export const ASPECTS_4MP = {
  '1:1': [2048, 2048],
  '4:3': [2400, 1792],
  '3:4': [1792, 2400],
  '3:2': [2528, 1696],
  '2:3': [1696, 2528],
  '16:9': [2752, 1536],
  '9:16': [1536, 2752]
}

/**
 * clip 字段是 config.models 里的 key：
 *   clip     = qwen3vl_8b_int8_convrot（8.71 GB，官方默认，画质基准）
 *   clipLean = qwen3vl_8b_w4a8（5.88 GB，与 DiT 常驻 16 GB 卡，换提示词不用重搬编码器）
 */
export const PRESETS = {
  fast: {
    label: 'fast',
    description: '1024² 25 步，快速草稿',
    unet: 'unet',
    clip: 'clipLean',
    steps: 25,
    sampler: 'euler',
    scheduler: 'simple',
    megapixels: 1,
    transparent: false
  },
  standard: {
    label: 'standard',
    description: '1024² 40 步，默认档（官方参数：cfg=1 / euler / simple）',
    unet: 'unet',
    clip: 'clip',
    steps: 40,
    sampler: 'euler',
    scheduler: 'simple',
    megapixels: 1,
    transparent: false
  },
  turbo: {
    label: 'turbo',
    description: 'turbo DiT + w4a8 编码器，8 步极速试构图（细节弱于 standard）',
    unet: 'unetTurbo',
    clip: 'clipLean',
    steps: 8,
    sampler: 'euler',
    scheduler: 'simple',
    megapixels: 1,
    transparent: false
  },
  quality: {
    label: 'quality',
    description: '原生 2K（约 4MP）40 步，成稿用；显存紧张时可能触发分块解码',
    unet: 'unet',
    clip: 'clip',
    steps: 40,
    sampler: 'euler',
    scheduler: 'simple',
    megapixels: 4,
    transparent: false
  },
  transparent: {
    label: 'transparent',
    description: '1024² 40 步，生成带 alpha 的 RGBA PNG（透明背景）',
    unet: 'unet',
    clip: 'clipLean',
    steps: 40,
    sampler: 'euler',
    scheduler: 'simple',
    megapixels: 1,
    transparent: true
  }
}

export const PRESET_NAMES = Object.keys(PRESETS)

export function presetFor(name) {
  const key = String(name || '').trim()
  if (!key) return { name: 'standard', preset: PRESETS.standard }
  const preset = PRESETS[key]
  if (!preset) {
    const error = new Error(`未知档位 preset=${key}，可选：${PRESET_NAMES.join(' / ')}`)
    error.code = 'BAD_ARGS'
    throw error
  }
  return { name: key, preset }
}

/** 按档位 + 比例给出尺寸。显式 width/height 会覆盖（但对齐到 32 的倍数）。 */
export function sizeFor(preset, aspectRatio) {
  const table = preset.megapixels >= 2 ? ASPECTS_4MP : ASPECTS_1MP
  const ratio = String(aspectRatio || '1:1').trim()
  const size = table[ratio]
  if (!size) {
    const error = new Error(
      `未知比例 aspect_ratio=${ratio}，可选：${Object.keys(table).join(' / ')}`
    )
    error.code = 'BAD_ARGS'
    throw error
  }
  return { width: size[0], height: size[1], aspectRatio: ratio }
}

/** 对齐到 32 的倍数（向上取整）：1000→1024、1080→1088。Qwen 的 16x 压缩 + 2 的整除要求。 */
export function align32(value) {
  const n = Math.ceil(Number(value) / 32) * 32
  return Math.max(64, n)
}
