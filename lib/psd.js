/**
 * 极简 PSD 写出器（零依赖）：把几张全画布 RGBA 图层写成一个能直接用 Photoshop
 * 打开的 .psd。
 *
 * 为什么自己写：插件一直是不带依赖的（npm install 这一步对用户就是门槛），
 * 而 PSD 的 RGB/8bit 子集结构其实很小——header + 每层记录 + 每通道原始数据。
 *
 * 取舍：
 *   - 通道用 compression=0（原始），不写 RLE。文件大一些，但不会因为打包器
 *     或 RLE 行表写错导致 Photoshop 打不开。
 *   - 每层都用整幅画布尺寸的矩形（不裁边界）。图层顺序 = 数组顺序，第 0 层在最下面。
 *   - 不写图层组、蒙版、调整层、智能对象。我们只需要"每层能被选中、能拖"。
 */

function u16(value) {
  const buf = Buffer.alloc(2)
  buf.writeUInt16BE(value & 0xffff, 0)
  return buf
}

function i16(value) {
  const buf = Buffer.alloc(2)
  buf.writeInt16BE(value, 0)
  return buf
}

function u32(value) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(value >>> 0, 0)
  return buf
}

function i32(value) {
  const buf = Buffer.alloc(4)
  buf.writeInt32BE(value, 0)
  return buf
}

function ascii(text) {
  return Buffer.from(text, 'ascii')
}

/** Pascal 风格图层名：1 字节长度 + 内容，整体补到 4 的倍数。
 *  PSD 的这段老字段按 MacRoman 解释，中文写进去会乱码；真正的中文名走后面的
 *  'luni'（Unicode layer name）附加块，这里只放 ASCII 兜底。 */
function layerName(index) {
  const raw = Buffer.from(`Layer ${index + 1}`, 'ascii')
  const head = Buffer.from([raw.length])
  const body = Buffer.concat([head, raw])
  const pad = (4 - (body.length % 4)) % 4
  return Buffer.concat([body, Buffer.alloc(pad)])
}

/** 'luni' 附加块：4 字节字符串长度（UTF-16 码元数）+ UTF-16BE 文本。 */
function unicodeName(name) {
  const utf16 = Buffer.from(String(name || ''), 'utf16le')
  utf16.swap16()
  const body = Buffer.concat([
    u32(utf16.length / 2),
    utf16,
    Buffer.alloc(utf16.length % 2)
  ])
  return Buffer.concat([ascii('8BIM'), ascii('luni'), u32(body.length), body])
}

function channelData(pixels, width, height, offset, length) {
  const plane = Buffer.alloc(width * height)
  for (let i = 0; i < width * height; i += 1) plane[i] = pixels[i * 4 + offset]
  return Buffer.concat([u16(0), plane])
}

/**
 * @param {{width:number,height:number,layers:{name?:string,image:{width:number,height:number,data:Uint8Array},visible?:boolean}[]}} doc
 * @returns {Buffer}
 */
export function writePsd(doc) {
  const { width, height } = doc
  if (!width || !height) throw new Error('PSD 需要宽高')
  if (!doc.layers || !doc.layers.length) throw new Error('PSD 至少一层')

  const header = Buffer.concat([
    ascii('8BPS'),
    u16(1),
    Buffer.alloc(6),
    u16(4),
    u32(height),
    u32(width),
    u16(8),
    u16(3)
  ])

  const colorMode = u32(0)
  const imageResources = u32(0)

  const records = []
  const channelBlocks = []

  doc.layers.forEach((layer, index) => {
    const image = layer.image
    if (image.width !== width || image.height !== height) throw new Error('图层尺寸必须和画布一致')

    const r = channelData(image.data, width, height, 0)
    const g = channelData(image.data, width, height, 1)
    const b = channelData(image.data, width, height, 2)
    const a = channelData(image.data, width, height, 3)
    channelBlocks.push(r, g, b, a)

    const channelInfo = Buffer.concat([
      i16(0), u32(r.length),
      i16(1), u32(g.length),
      i16(2), u32(b.length),
      i16(-1), u32(a.length)
    ])

    const flags = layer.visible === false ? 2 : 0
    const extra = Buffer.concat([
      u32(0), // 图层蒙版：无
      u32(0), // 混合范围：无
      layerName(index),
      unicodeName(layer.name || `图层 ${index + 1}`)
    ])

    records.push(
      Buffer.concat([
        i32(0), i32(0), i32(height), i32(width),
        u16(4),
        channelInfo,
        ascii('8BIM'),
        ascii('norm'),
        Buffer.from([255, 0, flags, 0]),
        u32(extra.length),
        extra
      ])
    )
  })

  const layerInfoBody = Buffer.concat([i16(doc.layers.length), ...records, ...channelBlocks])
  const layerInfo = Buffer.concat([
    u32(layerInfoBody.length),
    layerInfoBody,
    Buffer.alloc(layerInfoBody.length % 2)
  ])
  const globalMask = u32(0)
  const layerAndMask = Buffer.concat([u32(layerInfo.length + globalMask.length), layerInfo, globalMask])

  // 合成图：自下而上压平，写到 Image Data 段，没有 alpha 通道概念之外的差异
  const composite = new Uint8Array(width * height * 4)
  for (let i = 0; i < composite.length; i += 4) composite[i + 3] = 255
  for (const layer of doc.layers) {
    if (layer.visible === false) continue
    const src = layer.image.data
    for (let i = 0; i < composite.length; i += 4) {
      const sa = src[i + 3] / 255
      if (sa <= 0) continue
      const da = composite[i + 3] / 255
      const oa = sa + da * (1 - sa)
      for (let c = 0; c < 3; c += 1) {
        composite[i + c] = Math.round((src[i + c] * sa + composite[i + c] * da * (1 - sa)) / oa)
      }
      composite[i + 3] = Math.round(oa * 255)
    }
  }

  const imageData = Buffer.concat([
    u16(0),
    channelData(composite, width, height, 0),
    channelData(composite, width, height, 1),
    channelData(composite, width, height, 2),
    channelData(composite, width, height, 3)
  ])

  return Buffer.concat([header, colorMode, imageResources, layerAndMask, imageData])
}
