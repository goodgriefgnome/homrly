// Port of Pillow's bicubic resampling (src/libImaging/Resample.c) for 8-bit images,
// so that resizing gives exactly what homr's `Image.resize` gives.

const precisionBits = 32 - 8 - 2

function bicubic(x: number): number {
  // a = -0.5, as in Pillow
  const a = -0.5
  x = Math.abs(x)
  if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1
  if (x < 2) return (((x - 5) * x + 8) * x - 4) * a
  return 0
}
const bicubicSupport = 2

interface Coefficients {
  ksize: number
  /** First input pixel and number of input pixels for each output pixel */
  bounds: Int32Array
  /** Fixed-point weights, ksize per output pixel */
  weights: Int32Array
}

/** Pillow's precompute_coeffs followed by normalize_coeffs_8bpc. */
function coefficients(inSize: number, outSize: number): Coefficients {
  const scale = inSize / outSize
  const filterscale = Math.max(scale, 1)
  const support = bicubicSupport * filterscale
  const ksize = Math.ceil(support) * 2 + 1
  const bounds = new Int32Array(outSize * 2)
  const weights = new Int32Array(outSize * ksize)
  const k = new Float64Array(ksize)
  const ss = 1 / filterscale
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale
    // C's (int) cast truncates toward zero
    let xmin = Math.trunc(center - support + 0.5)
    if (xmin < 0) xmin = 0
    let xmax = Math.trunc(center + support + 0.5)
    if (xmax > inSize) xmax = inSize
    xmax -= xmin
    let ww = 0
    for (let x = 0; x < xmax; x++) {
      const w = bicubic((x + xmin - center + 0.5) * ss)
      k[x] = w
      ww += w
    }
    for (let x = 0; x < xmax; x++) {
      const w = ww !== 0 ? k[x]! / ww : k[x]!
      const fixed = w < 0 ? Math.trunc(-0.5 + w * (1 << precisionBits)) : Math.trunc(0.5 + w * (1 << precisionBits))
      weights[xx * ksize + x] = fixed
    }
    bounds[xx * 2] = xmin
    bounds[xx * 2 + 1] = xmax
  }
  return { ksize, bounds, weights }
}

function clip8(ss: number): number {
  // Arithmetic shift, then clamp, like Pillow's clip8 lookup table
  const v = ss >> precisionBits
  return v < 0 ? 0 : v > 255 ? 255 : v
}

/** Resizes interleaved 8-bit pixels with `channels` channels, like Pillow's BICUBIC resize. */
export function resizeBicubic(
  data: Uint8Array,
  width: number,
  height: number,
  channels: number,
  outWidth: number,
  outHeight: number,
): Uint8Array {
  let current = data
  let currentWidth = width
  // Pillow resamples horizontally first, and skips a pass whose size does not change
  if (outWidth !== width) {
    const { ksize, bounds, weights } = coefficients(width, outWidth)
    const out = new Uint8Array(outWidth * height * channels)
    for (let y = 0; y < height; y++) {
      const row = y * width * channels
      for (let xx = 0; xx < outWidth; xx++) {
        const xmin = bounds[xx * 2]!
        const xmax = bounds[xx * 2 + 1]!
        const kOffset = xx * ksize
        for (let c = 0; c < channels; c++) {
          let ss = 1 << (precisionBits - 1)
          for (let x = 0; x < xmax; x++) {
            ss += current[row + (xmin + x) * channels + c]! * weights[kOffset + x]!
          }
          out[(y * outWidth + xx) * channels + c] = clip8(ss)
        }
      }
    }
    current = out
    currentWidth = outWidth
  }
  if (outHeight !== height) {
    const { ksize, bounds, weights } = coefficients(height, outHeight)
    const stride = currentWidth * channels
    const out = new Uint8Array(outHeight * stride)
    for (let yy = 0; yy < outHeight; yy++) {
      const ymin = bounds[yy * 2]!
      const ymax = bounds[yy * 2 + 1]!
      const kOffset = yy * ksize
      for (let i = 0; i < stride; i++) {
        let ss = 1 << (precisionBits - 1)
        for (let y = 0; y < ymax; y++) {
          ss += current[(ymin + y) * stride + i]! * weights[kOffset + y]!
        }
        out[yy * stride + i] = clip8(ss)
      }
    }
    current = out
  }
  return current === data ? data.slice() : current
}
