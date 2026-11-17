/**
 * 图层相关的像素运算（零依赖）：缩放、合成、指标、裁剪。
 *
 * 约定：所有图像都是 { width, height, data: Uint8Array(RGBA) }，直通 alpha
 * （非预乘），这样和 PNG / PSD 的语义一致。
 */

/** 双线性缩放。合成校验和"原图 vs 拆层再合成"的对比都靠它。 */
export function resize(image, width, height) {
  const { data, width: sw, height: sh } = image
  const out = new Uint8Array(width * height * 4)
  const sx = sw / width
  const sy = sh / height
  for (let y = 0; y < height; y += 1) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sy - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(sh - 1, y0 + 1)
    const wy = fy - y0
    for (let x = 0; x < width; x += 1) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sx - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(sw - 1, x0 + 1)
      const wx = fx - x0
      const i00 = (y0 * sw + x0) * 4
      const i10 = (y0 * sw + x1) * 4
      const i01 = (y1 * sw + x0) * 4
      const i11 = (y1 * sw + x1) * 4
      const o = (y * width + x) * 4
      for (let c = 0; c < 4; c += 1) {
        const top = data[i00 + c] * (1 - wx) + data[i10 + c] * wx
        const bottom = data[i01 + c] * (1 - wx) + data[i11 + c] * wx
        out[o + c] = Math.round(top * (1 - wy) + bottom * wy)
      }
    }
  }
  return { width, height, data: out }
}

/** 把 top 叠到 bottom 上（source-over，直通 alpha）。 */
export function composite(bottom, top) {
  const out = new Uint8Array(bottom.data)
  const n = Math.min(out.length, top.data.length)
  for (let i = 0; i < n; i += 4) {
    const sa = top.data[i + 3] / 255
    if (sa <= 0) continue
    const da = out[i + 3] / 255
    const oa = sa + da * (1 - sa)
    if (oa <= 0) {
      out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0
      continue
    }
    for (let c = 0; c < 3; c += 1) {
      out[i + c] = Math.round((top.data[i + c] * sa + out[i + c] * da * (1 - sa)) / oa)
    }
    out[i + 3] = Math.round(oa * 255)
  }
  return { width: bottom.width, height: bottom.height, data: out }
}

/** 自下而上合成一组图层。 */
export function compositeAll(layers) {
  if (!layers.length) throw new Error('没有图层可合成')
  let out = layers[0]
  for (let i = 1; i < layers.length; i += 1) out = composite(out, layers[i])
  return out
}

/** 把半透明像素压到某个底色上（校验时和原图对齐用）。 */
export function flattenOn(image, [r, g, b]) {
  const out = new Uint8Array(image.data.length)
  for (let i = 0; i < out.length; i += 4) {
    const a = image.data[i + 3] / 255
    out[i] = Math.round(image.data[i] * a + r * (1 - a))
    out[i + 1] = Math.round(image.data[i + 1] * a + g * (1 - a))
    out[i + 2] = Math.round(image.data[i + 2] * a + b * (1 - a))
    out[i + 3] = 255
  }
  return { width: image.width, height: image.height, data: out }
}

/** RGB 均方误差 → PSNR（dB）。两边尺寸必须一致。 */
export function psnr(a, b) {
  let sum = 0
  let count = 0
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const d = a.data[i + c] - b.data[i + c]
      sum += d * d
      count += 1
    }
  }
  const mse = sum / Math.max(1, count)
  if (mse === 0) return Infinity
  return 10 * Math.log10((255 * 255) / mse)
}

function gaussianKernel(radius, sigma) {
  const size = radius * 2 + 1
  const kernel = new Float64Array(size)
  let sum = 0
  for (let i = 0; i < size; i += 1) {
    const x = i - radius
    const v = Math.exp(-(x * x) / (2 * sigma * sigma))
    kernel[i] = v
    sum += v
  }
  for (let i = 0; i < size; i += 1) kernel[i] /= sum
  return kernel
}

/** 灰度 SSE 用的亮度通道。 */
function luma(image) {
  const out = new Float64Array(image.width * image.height)
  for (let i = 0, p = 0; p < image.data.length; i += 1, p += 4) {
    out[i] = 0.2126 * image.data[p] + 0.7152 * image.data[p + 1] + 0.0722 * image.data[p + 2]
  }
  return out
}

/**
 * 高斯窗 SSIM（11×11，sigma=1.5，和论文/常用的 scikit-image 一致）。
 * 只算亮度通道——我们比较的是"拆完能不能合回去"，色度差异 PSNR 已经覆盖。
 */
export function ssim(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('SSIM 需要同尺寸')
  const { width, height } = a
  const la = luma(a)
  const lb = luma(b)
  const radius = 5
  const kernel = gaussianKernel(radius, 1.5)
  const C1 = (0.01 * 255) ** 2
  const C2 = (0.03 * 255) ** 2

  let total = 0
  let count = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let ma = 0
      let mb = 0
      let wsum = 0
      for (let dy = -radius; dy <= radius; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        const ky = kernel[dy + radius]
        for (let dx = -radius; dx <= radius; dx += 1) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          const k = ky * kernel[dx + radius]
          const idx = yy * width + xx
          ma += la[idx] * k
          mb += lb[idx] * k
          wsum += k
        }
      }
      ma /= wsum
      mb /= wsum
      let va = 0
      let vb = 0
      let cov = 0
      for (let dy = -radius; dy <= radius; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        const ky = kernel[dy + radius]
        for (let dx = -radius; dx <= radius; dx += 1) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          const k = ky * kernel[dx + radius]
          const idx = yy * width + xx
          const da = la[idx] - ma
          const db = lb[idx] - mb
          va += da * da * k
          vb += db * db * k
          cov += da * db * k
        }
      }
      va /= wsum
      vb /= wsum
      cov /= wsum
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2))
      count += 1
    }
  }
  return total / Math.max(1, count)
}

/** 非零 alpha 的包围盒；全透明返回 null。 */
export function alphaBounds(image, threshold = 2) {
  let minX = image.width
  let minY = image.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/** 裁一块出来（越界自动贴边）。 */
export function crop(image, x, y, width, height) {
  const out = new Uint8Array(width * height * 4)
  for (let row = 0; row < height; row += 1) {
    const sy = Math.min(image.height - 1, Math.max(0, y + row))
    for (let col = 0; col < width; col += 1) {
      const sx = Math.min(image.width - 1, Math.max(0, x + col))
      const si = (sy * image.width + sx) * 4
      const di = (row * width + col) * 4
      out[di] = image.data[si]
      out[di + 1] = image.data[si + 1]
      out[di + 2] = image.data[si + 2]
      out[di + 3] = image.data[si + 3]
    }
  }
  return { width, height, data: out }
}
