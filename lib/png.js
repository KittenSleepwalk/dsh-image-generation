/**
 * 极简 PNG 编解码（零依赖，只用 node:zlib）。
 *
 * 只做我们真正需要的事：
 *   - 读 ComfyUI 存出来的 PNG（8 bit，灰度 / RGB / RGBA / 带 tRNS，非隔行）
 *   - 写 RGBA PNG（合成图、图层导出、PSD 中间产物都用它）
 *
 * 不做：调色板（colorType=3）、16 bit、隔行。遇到就明确抛错，不静默糊弄。
 */

import zlib from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** 解一张 PNG → { width, height, data: Uint8Array(RGBA) }。 */
export function decodePng(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG 文件')

  let offset = 8
  let header
  const idat = []
  let palette = null
  let trns = null

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12]
      }
    } else if (type === 'PLTE') {
      palette = Buffer.from(data)
    } else if (type === 'tRNS') {
      trns = Buffer.from(data)
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
  }

  if (!header) throw new Error('PNG 缺少 IHDR')
  if (header.bitDepth !== 8) throw new Error(`暂不支持 ${header.bitDepth} bit PNG`)
  if (header.interlace !== 0) throw new Error('暂不支持隔行 PNG')
  if (header.colorType === 3) throw new Error('暂不支持调色板 PNG')

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType]
  if (!channels) throw new Error(`未知 PNG colorType=${header.colorType}`)

  const { width, height } = header
  const stride = width * channels
  const raw = zlib.inflateSync(Buffer.concat(idat))
  if (raw.length < height * (stride + 1)) throw new Error('PNG 数据不完整')

  const pixels = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      const v = line[x]
      switch (filter) {
        case 0: out[x] = v; break
        case 1: out[x] = (v + a) & 0xff; break
        case 2: out[x] = (v + b) & 0xff; break
        case 3: out[x] = (v + ((a + b) >> 1)) & 0xff; break
        case 4: out[x] = (v + paeth(a, b, c)) & 0xff; break
        default: throw new Error(`PNG 行过滤类型未知：${filter}`)
      }
    }
    prev = out
  }

  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0, p = 0; i < width * height; i += 1, p += channels) {
    if (channels === 1) {
      const g = pixels[p]
      rgba[i * 4] = g
      rgba[i * 4 + 1] = g
      rgba[i * 4 + 2] = g
      rgba[i * 4 + 3] = 255
    } else if (channels === 2) {
      const g = pixels[p]
      rgba[i * 4] = g
      rgba[i * 4 + 1] = g
      rgba[i * 4 + 2] = g
      rgba[i * 4 + 3] = pixels[p + 1]
    } else if (channels === 3) {
      rgba[i * 4] = pixels[p]
      rgba[i * 4 + 1] = pixels[p + 1]
      rgba[i * 4 + 2] = pixels[p + 2]
      rgba[i * 4 + 3] = 255
    } else {
      rgba[i * 4] = pixels[p]
      rgba[i * 4 + 1] = pixels[p + 1]
      rgba[i * 4 + 2] = pixels[p + 2]
      rgba[i * 4 + 3] = pixels[p + 3]
    }
  }
  return { width, height, data: rgba }
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** 把 RGBA 像素编码成 PNG（8 bit，无隔行）。 */
export function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}
