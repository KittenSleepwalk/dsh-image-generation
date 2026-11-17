/**
 * ComfyUI API 格式工作流构建（纯函数，不碰网络/文件系统，可离线单测）。
 *
 * 对标官方模板 image_qwen_image_2_1_t2i.json 的最小等价图：
 *
 *   UNETLoader ─┐
 *   CLIPLoader ─┴→ TextEncodeQwenImage21 ─pos/neg─┐
 *   EmptyLatentImage ────────────────────────────┴→ KSampler → VAEDecode → SaveImage/PreviewImage
 *
 * 与 SDXL 的关键差异：没有 CheckpointLoaderSimple，模型是三件套（UNET/CLIP/VAE）；
 * 提示词必须走 TextEncodeQwenImage21（不能用 CLIPTextEncode）。
 */

export const NODE_IDS = {
  unet: '1',
  clip: '2',
  vae: '3',
  encode: '4',
  latent: '5',
  sampler: '6',
  decode: '7',
  save: '8',
  cache: '9'
}

/**
 * @param {object} input
 * @param {object} input.request           normalizeRequest 的结果
 * @param {object} input.models            config.models（key → 文件名）
 * @param {string} input.filenamePrefix    ComfyUI 侧文件名前缀（keepComfyOutput 时用）
 * @param {boolean} [input.keepComfyOutput]
 * @param {boolean} [input.useLatentCache]
 * @returns {{workflow: object, outputNodeId: string, outputClass: string, resolvedModels: object}}
 */
export function buildText2Img(input) {
  const { request, models } = input
  const useLatentCache = input.useLatentCache === true
  const keepComfyOutput = input.keepComfyOutput === true

  const unetFile = models[request.preset.unet]
  const clipFile = models[request.preset.clip]
  const vaeFile = models.vae
  for (const [role, value] of Object.entries({ unet: unetFile, clip: clipFile, vae: vaeFile })) {
    if (!value) {
      throw new Error(`配置里缺少 models.${role}（当前档位 ${request.preset.name} 需要它）`)
    }
  }

  const workflow = {
    [NODE_IDS.unet]: {
      class_type: 'UNETLoader',
      inputs: { unet_name: unetFile, weight_dtype: 'default' },
      _meta: { title: 'Qwen-Image 2.1 DiT（int8）' }
    },
    [NODE_IDS.clip]: {
      class_type: 'CLIPLoader',
      inputs: { clip_name: clipFile, type: 'qwen_image', device: 'default' },
      _meta: { title: 'Qwen3-VL 8B 文本编码器' }
    },
    [NODE_IDS.vae]: {
      class_type: 'VAELoader',
      inputs: { vae_name: vaeFile },
      _meta: { title: 'RGBA VAE' }
    },
    [NODE_IDS.encode]: {
      class_type: 'TextEncodeQwenImage21',
      inputs: {
        clip: [NODE_IDS.clip, 0],
        prompt: request.finalPrompt,
        negative_prompt: request.negativePrompt,
        // 只有接参考图时才有意义；纯文生图保持 1024 不影响出图
        resolution: 1024
      },
      _meta: { title: '提示词编码' }
    },
    [NODE_IDS.latent]: {
      class_type: 'EmptyLatentImage',
      inputs: { width: request.width, height: request.height, batch_size: 1 },
      _meta: { title: `空潜空间 ${request.width}x${request.height}` }
    },
    [NODE_IDS.decode]: {
      class_type: 'VAEDecode',
      inputs: { samples: [NODE_IDS.sampler, 0], vae: [NODE_IDS.vae, 0] },
      _meta: { title: 'VAE 解码' }
    }
  }

  // 纯文生图其实不需要 cache 节点；留成开关，编辑/多参考时再打开
  let modelRef = [NODE_IDS.unet, 0]
  if (useLatentCache) {
    workflow[NODE_IDS.cache] = {
      class_type: 'QwenImage21Cache',
      inputs: { model: [NODE_IDS.unet, 0], device: 'auto', dtype: 'default' },
      _meta: { title: 'Qwen 2.1 前缀 KV cache' }
    }
    modelRef = [NODE_IDS.cache, 0]
  }

  workflow[NODE_IDS.sampler] = {
    class_type: 'KSampler',
    inputs: {
      seed: request.seed,
      steps: request.steps,
      cfg: request.cfgScale,
      sampler_name: request.sampler,
      scheduler: request.scheduler,
      denoise: 1,
      model: modelRef,
      positive: [NODE_IDS.encode, 0],
      negative: [NODE_IDS.encode, 1],
      latent_image: [NODE_IDS.latent, 0]
    },
    _meta: { title: `KSampler ${request.steps} 步 ${request.sampler}/${request.scheduler}` }
  }

  let outputClass
  if (keepComfyOutput) {
    outputClass = 'SaveImage'
    workflow[NODE_IDS.save] = {
      class_type: 'SaveImage',
      inputs: { filename_prefix: input.filenamePrefix || 'dsh-qwen-image', images: [NODE_IDS.decode, 0] },
      _meta: { title: '保存到 ComfyUI/output' }
    }
  } else {
    // PreviewImage 落在 ComfyUI 的 temp 目录，不污染它的 output
    outputClass = 'PreviewImage'
    workflow[NODE_IDS.save] = {
      class_type: 'PreviewImage',
      inputs: { images: [NODE_IDS.decode, 0] },
      _meta: { title: '预览并取回' }
    }
  }

  return {
    workflow,
    outputNodeId: NODE_IDS.save,
    outputClass,
    resolvedModels: { unet: unetFile, clip: clipFile, vae: vaeFile }
  }
}

/** 给 doctor / 报错文案用：当前档位到底会用哪几个文件。 */
export function describeModels(request, models) {
  return {
    unet: models[request.preset.unet],
    clip: models[request.preset.clip],
    vae: models.vae
  }
}
