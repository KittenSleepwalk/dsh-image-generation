/**
 * Qwen-Image-Layered：把一张已经画好的图拆成多个 RGBA 图层。
 *
 * 为什么是这个顺序：两次独立生成对不齐（光、色、透视、边缘都不一样），
 * 而"拆"有确定性约束——合回去必须等于原图，所以能训练、也能量化验收。
 *
 * 本模块只做四件事：
 *   1. 组工作流（和官方 image_qwen_image_layered 模板一致，可换 GGUF 权重）
 *   2. 送进 ComfyUI、等结果、把每层下载成本地 PNG
 *   3. 自下而上合成 + 和原图比 PSNR/SSIM（验收用）
 *   4. 给出每层的包围盒，方便画布上做命中测试
 */

import fs from 'node:fs'
import path from 'node:path'

import { decodePng, encodePng } from './png.js'
import { alphaBounds, compositeAll, crop, flattenOn, psnr, resize, ssim } from './imageops.js'

/** 默认权重名：和 ComfyUI 的 models/ 目录约定一致。 */
export const LAYERED_MODELS = {
  unet: 'qwen_image_layered_bf16.safetensors',
  unetGguf: 'Qwen_Image_Layered-Q4_K_M.gguf',
  clip: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
  vae: 'qwen_image_layered_vae.safetensors'
}

/**
 * 把任意尺寸收进 max 边、并让宽高都是 multiple 的倍数。
 * 必须自己算：EmptyQwenImageLayeredLatentImage 的 latent 尺寸是 H//8、W//8，
 * 和 VAEEncode 出来的必须对得上，否则采样阶段形状不匹配。
 */
export function fitSize(width, height, max = 640, multiple = 16) {
  const scale = Math.min(1, max / Math.max(width, height))
  const snap = (v) => Math.max(multiple, Math.round((v * scale) / multiple) * multiple)
  return { width: snap(width), height: snap(height) }
}

/** 组 API 格式的工作流。 */
export function buildLayeredWorkflow(options) {
  const {
    imageName,
    width,
    height,
    layers = 4,
    prompt = '',
    negative = '',
    seed = 0,
    steps = 20,
    cfg = 2.5,
    models = LAYERED_MODELS,
    gguf = true,
    prefix = 'ks-layered/layer'
  } = options

  const clipLoader = gguf && models.clipGguf ? 'CLIPLoaderGGUF' : 'CLIPLoader'
  const unetLoader = gguf ? 'UnetLoaderGGUF' : 'UNETLoader'

  const workflow = {
    1: { class_type: 'LoadImage', inputs: { image: imageName } },
    2: {
      class_type: 'ImageScale',
      inputs: { image: ['1', 0], upscale_method: 'lanczos', width, height, crop: 'disabled' }
    },
    3: { class_type: 'VAELoader', inputs: { vae_name: models.vae } },
    4: { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['3', 0] } },
    5: {
      class_type: clipLoader,
      inputs: clipLoader === 'CLIPLoaderGGUF'
        ? { clip_name: models.clipGguf, type: 'qwen_image' }
        : { clip_name: models.clip, type: 'qwen_image', device: 'default' }
    },
    6: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['5', 0] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['5', 0] } },
    8: {
      class_type: unetLoader,
      inputs: unetLoader === 'UnetLoaderGGUF'
        ? { unet_name: models.unetGguf }
        : { unet_name: models.unet, weight_dtype: 'default' }
    },
    9: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['8', 0], shift: 1 } },
    10: {
      class_type: 'EmptyQwenImageLayeredLatentImage',
      inputs: { width, height, layers, batch_size: 1 }
    },
    11: { class_type: 'ReferenceLatent', inputs: { conditioning: ['6', 0], latent: ['4', 0] } },
    12: { class_type: 'ReferenceLatent', inputs: { conditioning: ['7', 0], latent: ['4', 0] } },
    13: {
      class_type: 'KSampler',
      inputs: {
        model: ['9', 0],
        positive: ['11', 0],
        negative: ['12', 0],
        latent_image: ['10', 0],
        seed,
        steps,
        cfg,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1
      }
    },
    14: { class_type: 'LatentCut', inputs: { samples: ['13', 0], dim: 't', index: 1, amount: 16384 } },
    15: { class_type: 'LatentCutToBatch', inputs: { samples: ['14', 0], dim: 't', slice_size: 1 } },
    16: { class_type: 'VAEDecode', inputs: { samples: ['15', 0], vae: ['3', 0] } },
    17: { class_type: 'SaveImage', inputs: { images: ['16', 0], filename_prefix: prefix } }
  }

  return workflow
}

/** 把源图复制进 ComfyUI 的 input 目录（LoadImage 只认那里）。 */
/**
 * 把待拆的图放进 ComfyUI 的 input 目录。
 *
 * 只能放根目录：0.40.0 的 LoadImage 枚举的是 input 下的**文件**（不递归），
 * 放到子目录里 /object_info 看不见，提交时会被判成非法值。
 */
export function stageInput(comfyRoot, sourceFile) {
  const dir = path.join(comfyRoot, 'input')
  fs.mkdirSync(dir, { recursive: true })
  const base = path.basename(sourceFile).replace(/[^\w.-]/g, '_')
  const name = `kslayered-${base}`
  const target = path.join(dir, name)
  fs.copyFileSync(sourceFile, target)
  return { name, file: target }
}

function loadImage(file) {
  const image = decodePng(fs.readFileSync(file))
  return { ...image, file }
}

/**
 * 跑一次拆层。
 * @returns {Promise<{layers: object[], composite: object, metrics: object, raw: string[], elapsedMs: number}>}
 */
export async function runLayered(client, options) {
  const {
    sourceFile,
    comfyRoot,
    layers = 4,
    prompt = '',
    negative = '',
    seed = 20261106,
    steps = 20,
    cfg = 2.5,
    timeoutMs = 15 * 60 * 1000,
    models = LAYERED_MODELS,
    gguf = true,
    outDir,
    onTick
  } = options

  const source = loadImage(sourceFile)
  const size = fitSize(source.width, source.height, options.maxDimension || 640)
  const staged = stageInput(comfyRoot, sourceFile)
  const prefix = `ks-layered/${Date.now()}-${seed}`
  const workflow = buildLayeredWorkflow({
    imageName: staged.name,
    width: size.width,
    height: size.height,
    layers,
    prompt,
    negative,
    seed,
    steps,
    cfg,
    models,
    gguf,
    prefix
  })

  const started = Date.now()
  const promptId = await client.submit(workflow)
  const { images } = await client.waitFor(promptId, { timeoutMs, onTick })
  const elapsedMs = Date.now() - started

  const dir = outDir || path.join(path.dirname(sourceFile), `layers-${seed}`)
  fs.mkdirSync(dir, { recursive: true })

  const raw = []
  for (let i = 0; i < images.length; i += 1) {
    const file = path.join(dir, `layer-${String(i).padStart(2, '0')}.png`)
    await client.download(images[i], file)
    raw.push(file)
  }

  const decoded = raw.map((file) => loadImage(file))
  const composite = compositeAll(decoded)
  const reference = resize(flattenOn(source, [255, 255, 255]), size.width, size.height)
  const composited = flattenOn(composite, [255, 255, 255])

  const bounds = decoded.map((image, index) => {
    const box = alphaBounds(image)
    return { index, file: raw[index], empty: !box, box: box || { x: 0, y: 0, width: 0, height: 0 } }
  })

  return {
    layers: decoded,
    bounds,
    composite,
    compositeFile: (() => {
      const file = path.join(dir, 'composite.png')
      fs.writeFileSync(file, encodePng(composite.width, composite.height, composite.data))
      return file
    })(),
    metrics: {
      width: size.width,
      height: size.height,
      count: decoded.length,
      psnr: psnr(reference, composited),
      ssim: ssim(reference, composited),
      elapsedMs
    },
    raw,
    dir
  }
}

/** 裁出某一层（给"替换零件/单独导出"用）。 */
export function cropLayer(image, box, padding = 8) {
  const x = Math.max(0, box.x - padding)
  const y = Math.max(0, box.y - padding)
  const width = Math.min(image.width - x, box.width + padding * 2)
  const height = Math.min(image.height - y, box.height + padding * 2)
  return { x, y, width, height, image: crop(image, x, y, width, height) }
}
