/**
 * 参考图风格迁移：把 docs/参考图（…）.png 用 ComfyUI img2img 改成指定风格，
 * 输出「参考图（<内容>｜风格：<目标风格>）.png」，用于扩充参考图样本集。
 *
 * 用法：node scripts/style-transfer-refs.mjs --styles=flat,picturebook --denoise=0.6 [--limit=7]
 * 依赖：本地 ComfyUI（未启动会自动拉起）、Qwen-Image-2.1 权重（UNET/CLIP/VAE）。
 */

import fs from 'node:fs'
import path from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { ensureServer, scheduleIdleShutdown } from '../lib/server.js'
import { ComfyClient } from '../lib/comfy.js'
import { logInfo, logWarn } from '../lib/log.js'

const DOCS_DIR = path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..', 'docs')

const STYLE_PRESETS = {
  flat: {
    label: '扁平矢量',
    prompt: 'flat vector infographic illustration, solid color blocks, no gradients, clean thick outlines, rounded rectangles, generous white space, minimal editorial PPT style'
  },
  glass: {
    label: '玻璃拟态',
    prompt: 'glassmorphism infographic, translucent frosted glass panels, soft glow, subtle blur, layered depth with clear boundaries, modern tech look'
  },
  clay: {
    label: '3D 软塑 IP',
    prompt: '3D soft clay render, rounded glossy plastic material, cute robot IP character, pastel gradient background, soft studio lighting'
  },
  picturebook: {
    label: '绘本彩铅',
    prompt: 'children picture-book colored pencil illustration with watercolor wash, visible paper grain, warm hand-drawn feel, soft edges'
  },
  academic: {
    label: '学术示意',
    prompt: 'academic schematic diagram, thin line boxes, grayscale with one accent color, minimal decoration, precise diagram style'
  }
}

function argOf(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.find((arg) => arg.startsWith(prefix))
  return found ? found.slice(prefix.length) : fallback
}

function safeName(text) {
  return String(text || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
}

function listReferenceImages() {
  return fs
    .readdirSync(DOCS_DIR)
    .filter((name) => /^参考图（.+）\.(png|jpg|jpeg)$/i.test(name) && !name.includes('｜风格：'))
    .map((name) => {
      const match = name.match(/^参考图（(.+)）\.(png|jpg|jpeg)$/i)
      return { name, annotation: match ? match[1] : name, file: path.join(DOCS_DIR, name) }
    })
}

function buildWorkflow({ imageName, style, denoise, models, seed }) {
  return {
    '1': { class_type: 'LoadImage', inputs: { image: imageName, upload: 'image' } },
    '2': { class_type: 'VAEEncode', inputs: { pixels: ['1', 0], vae: ['5', 0] } },
    '3': { class_type: 'UNETLoader', inputs: { unet_name: models.unet, weight_dtype: 'default' } },
    '4': { class_type: 'CLIPLoader', inputs: { clip_name: models.clip, type: 'qwen_image', device: 'default' } },
    '5': { class_type: 'VAELoader', inputs: { vae_name: models.vae } },
    '6': {
      class_type: 'TextEncodeQwenImage21',
      inputs: {
        clip: ['4', 0],
        prompt: `保持参考图的内容、版式与元素位置不变，只把画法改成：${style.prompt}。不要新增或删掉主体，不要改变层级/流程关系，画面简洁、适合科普 PPT 配图。`,
        negative_prompt: '',
        resolution: 1024
      }
    },
    '7': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: 30,
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
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'ks_style_transfer', images: ['8', 0] } }
  }
}

async function main() {
  const config = resolveConfig({})
  const stylesArg = argOf('styles', 'flat,picturebook')
  const denoise = Number(argOf('denoise', '0.6'))
  const limit = Number(argOf('limit', '99'))
  const outDir = path.resolve(argOf('outdir', DOCS_DIR))
  fs.mkdirSync(outDir, { recursive: true })
  const styleKeys = stylesArg.split(',').map((key) => key.trim()).filter((key) => STYLE_PRESETS[key])
  const refs = listReferenceImages().slice(0, limit)
  if (!styleKeys.length) throw new Error('没有有效风格：可用 ' + Object.keys(STYLE_PRESETS).join(','))
  if (!refs.length) throw new Error('docs 下没有参考图')

  logInfo(`风格迁移：${refs.length} 张参考图 × ${styleKeys.length} 种风格，denoise=${denoise}`)
  const server = await ensureServer(config, { log: (msg) => logInfo(msg) })
  const client = new ComfyClient(server.baseUrl)

  const inputDir = path.join(config.comfy.cwd, 'input', 'style-refs')
  fs.mkdirSync(inputDir, { recursive: true })
  const models = config.models

  const results = []
  for (const ref of refs) {
    const staged = safeName(ref.name)
    fs.copyFileSync(ref.file, path.join(inputDir, staged))
    const imageName = 'style-refs/' + staged
    for (const key of styleKeys) {
      const style = STYLE_PRESETS[key]
      const outName = `参考图（${ref.annotation}｜风格：${style.label}）.png`
      const outPath = path.join(outDir, outName)
      if (fs.existsSync(outPath)) {
        logInfo(`跳过已存在：${outName}`)
        continue
      }
      const seed = Math.floor(Math.random() * 2 ** 31)
      const workflow = buildWorkflow({ imageName, style, denoise, models, seed })
      const promptId = await client.submit(workflow)
      const { images } = await client.waitFor(promptId, { timeoutMs: 15 * 60 * 1000 })
      await client.download(images[0], outPath)
      results.push({ source: ref.name, style: style.label, styleKey: key, file: outName, seed, denoise })
      logInfo(`完成：${outName}`)
    }
  }

  // 索引按目录实际文件重建（含之前批次已生成的）
  const migrated = fs.readdirSync(outDir).filter((name) => name.includes('｜风格：') && /\.png$/i.test(name))
  const indexPath = path.join(outDir, '参考图风格迁移索引.md')
  const lines = ['# 参考图风格迁移索引', '', `- 生成时间：${new Date().toISOString()}`, `- img2img denoise：${denoise}`, `- 迁移样本：${migrated.length} 张`, '']
  lines.push('| 原参考图 | 目标风格 | 输出文件 |')
  lines.push('|---|---|---|')
  for (const name of migrated.sort()) {
    const match = name.match(/^参考图（(.+?)｜风格：(.+?)）\.png$/i)
    if (match) lines.push(`| ${match[1]} | ${match[2]} | ${name} |`)
  }
  fs.writeFileSync(indexPath, lines.join('\n') + '\n', 'utf8')
  logInfo(`索引已写入：${indexPath}（${migrated.length} 张）`)
  scheduleIdleShutdown(config, { log: (msg) => logInfo(msg) })
  console.log(JSON.stringify({ ok: true, count: results.length, index: indexPath }, null, 2))
}

main().catch((error) => {
  logWarn('风格迁移失败：' + error.message)
  console.error(error)
  process.exit(1)
})
