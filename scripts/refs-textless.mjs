/**
 * 参考图去字底案（对应 SKILL H 文字：图像与文字分离）
 *
 * 输入：docs/参考图（…）.png（含手写中文标签的原始参考图）
 * 输出：docs/底案（…）.png（同一构图、同一画法，但**不含任何文字**；原文字位置留空白文字框/留白）
 *
 * 做法：ComfyUI img2img，低 denoise（默认 0.45）只改文字区域，保持主体/分层/箭头/配色。
 * 文字内容由 docs/文字参考（…）.md 单独保存（人工/OCR 整理，作为后期 PPT 文字层参考）。
 *
 * 用法：node scripts/refs-textless.mjs [--denoise=0.45] [--limit=7] [--outdir=…]
 */

import fs from 'node:fs'
import path from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { ensureServer, scheduleIdleShutdown } from '../lib/server.js'
import { ComfyClient } from '../lib/comfy.js'
import { logInfo, logWarn } from '../lib/log.js'

const DOCS_DIR = path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..', 'docs')

const REMOVE_TEXT_PROMPT = [
  'Remove ALL text from this image: delete every Chinese character, letter, number, word, handwriting and label,',
  'including text inside rounded boxes, bubbles and callouts.',
  'Keep everything else EXACTLY as it is: the objects, panels, layer bands, arrows, icons, layout and colors.',
  'Where a label used to be, leave a clean empty rounded box or blank white space of the same color.',
  'The final image must contain no text, no letters, no numbers and no handwriting anywhere.'
].join(' ')

function argOf(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.find((arg) => arg.startsWith(prefix))
  return found ? found.slice(prefix.length) : fallback
}

function safeName(text) {
  return String(text || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
}

function listRefs() {
  return fs
    .readdirSync(DOCS_DIR)
    .filter((name) => /^参考图（.+）\.(png|jpg|jpeg)$/i.test(name) && !name.includes('｜风格：'))
    .map((name) => {
      const match = name.match(/^参考图（(.+)）\.(png|jpg|jpeg)$/i)
      return { name, annotation: match ? match[1] : name, file: path.join(DOCS_DIR, name) }
    })
}


const INPAINT_PROMPT =
  'clean completely blank area: plain light paper background or an empty rounded label box matching the surrounding colors, ' +
  'no text, no letters, no numbers, no handwriting, no symbols anywhere in this area'

function buildInpaintWorkflow({ imageName, maskName, models, seed }) {
  return {
    '1': { class_type: 'LoadImage', inputs: { image: imageName, upload: 'image' } },
    '2': { class_type: 'LoadImage', inputs: { image: maskName, upload: 'image' } },
    '3': { class_type: 'ImageToMask', inputs: { image: ['2', 0], channel: 'red' } },
    '4': { class_type: 'VAEEncode', inputs: { pixels: ['1', 0], vae: ['6', 0] } },
    '5': { class_type: 'SetLatentNoiseMask', inputs: { samples: ['4', 0], mask: ['3', 0] } },
    '6': { class_type: 'VAELoader', inputs: { vae_name: models.vae } },
    '7': { class_type: 'UNETLoader', inputs: { unet_name: models.unet, weight_dtype: 'default' } },
    '8': { class_type: 'CLIPLoader', inputs: { clip_name: models.clip, type: 'qwen_image', device: 'default' } },
    '9': { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['8', 0], prompt: INPAINT_PROMPT, negative_prompt: '', resolution: 1024 } },
    '10': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: 25,
        cfg: 1,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
        model: ['7', 0],
        positive: ['9', 0],
        negative: ['9', 1],
        latent_image: ['5', 0]
      }
    },
    '11': { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['6', 0] } },
    '12': { class_type: 'SaveImage', inputs: { filename_prefix: 'ks_textless_inpaint', images: ['11', 0] } }
  }
}

function buildWorkflow({ imageName, models, seed, denoise }) {
  return {
    '1': { class_type: 'LoadImage', inputs: { image: imageName, upload: 'image' } },
    '2': { class_type: 'VAEEncode', inputs: { pixels: ['1', 0], vae: ['5', 0] } },
    '3': { class_type: 'UNETLoader', inputs: { unet_name: models.unet, weight_dtype: 'default' } },
    '4': { class_type: 'CLIPLoader', inputs: { clip_name: models.clip, type: 'qwen_image', device: 'default' } },
    '5': { class_type: 'VAELoader', inputs: { vae_name: models.vae } },
    '6': { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['4', 0], prompt: REMOVE_TEXT_PROMPT, negative_prompt: '', resolution: 1024 } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: 25,
        cfg: 1,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise,
        model: ['3', 0],
        positive: ['6', 0],
        negative: ['6', 1],
        latent_image: ['2', 0]
      }
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['5', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'ks_textless_base', images: ['8', 0] } }
  }
}

async function main() {
  const config = resolveConfig({})
  const denoise = Number(argOf('denoise', '0.45'))
  const mode = argOf('mode', 'img2img')
  const masksDir = path.resolve(argOf('masks', path.join(DOCS_DIR, '_masks')))
  const limit = Number(argOf('limit', '99'))
  const outDir = path.resolve(argOf('outdir', DOCS_DIR))
  const only = argOf('only', '')
  const force = process.argv.includes('--force')
  fs.mkdirSync(outDir, { recursive: true })

  const refs = listRefs().filter((ref) => !only || ref.annotation.includes(only)).slice(0, limit)
  if (!refs.length) throw new Error('docs 下没有参考图')
  logInfo(`去字底案：${refs.length} 张，denoise=${denoise}`)

  const server = await ensureServer(config, { log: (msg) => logInfo(msg) })
  const client = new ComfyClient(server.baseUrl)
  const inputDir = path.join(config.comfy.cwd, 'input', 'textless-refs')
  fs.mkdirSync(inputDir, { recursive: true })

  const results = []
  for (const ref of refs) {
    const outName = `底案（${ref.annotation}）.png`
    const outPath = path.join(outDir, outName)
    if (fs.existsSync(outPath) && !force) {
      logInfo(`跳过已存在：${outName}`)
      results.push({ file: outName, skipped: true })
      continue
    }
    const staged = safeName(ref.name)
    fs.copyFileSync(ref.file, path.join(inputDir, staged))
    const seed = Math.floor(Math.random() * 2 ** 31)
    let promptId
    if (mode === 'inpaint') {
      const maskPath = path.join(masksDir, ref.name)
      if (!fs.existsSync(maskPath)) { logWarn('缺少遮罩，跳过：' + ref.name); continue }
      const maskDirInput = path.join(config.comfy.cwd, 'input', 'textless-masks')
      fs.mkdirSync(maskDirInput, { recursive: true })
      fs.copyFileSync(maskPath, path.join(maskDirInput, staged))
      promptId = await client.submit(buildInpaintWorkflow({ imageName: 'textless-refs/' + staged, maskName: 'textless-masks/' + staged, models: config.models, seed }))
    } else {
      promptId = await client.submit(buildWorkflow({ imageName: 'textless-refs/' + staged, models: config.models, seed, denoise }))
    }
    const { images } = await client.waitFor(promptId, { timeoutMs: 15 * 60 * 1000 })
    await client.download(images[0], outPath)
    results.push({ file: outName, seed })
    logInfo(`完成：${outName}`)
  }

  const baseFiles = fs.readdirSync(outDir).filter((name) => /^底案（.+）\.png$/i.test(name))
  const indexPath = path.join(outDir, '底案索引.md')
  const lines = ['# 参考图去字底案索引', '', `- 生成时间：${new Date().toISOString()}`, `- img2img denoise：${denoise}`, `- 底案数量：${baseFiles.length}`, '', '| 底案文件 | 对应的原始参考图 | 文字参考 |', '|---|---|---|']
  for (const name of baseFiles.sort()) {
    const annotation = (name.match(/^底案（(.+)）\.png$/i) || [])[1] || ''
    lines.push(`| ${name} | 参考图（${annotation}）.png | 文字参考（${annotation}）.md |`)
  }
  fs.writeFileSync(indexPath, lines.join('\n') + '\n', 'utf8')
  logInfo(`索引已写入：${indexPath}`)
  scheduleIdleShutdown(config, { log: (msg) => logInfo(msg) })
  console.log(JSON.stringify({ ok: true, count: baseFiles.length, index: indexPath }, null, 2))
}

main().catch((error) => {
  logWarn('去字底案失败：' + error.message)
  console.error(error)
  process.exit(1)
})
