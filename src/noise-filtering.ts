// Port of homr/noise_filtering.py: blanks out regions where the staff prediction is noise.
import type { InputPredictions, Mask } from './predictions.js'

const imageNoiseLimit = 50

/** OpenCV's borderInterpolate for BORDER_REFLECT_101. */
function reflect101(p: number, len: number): number {
  if (p >= 0 && p < len) return p
  if (len === 1) return 0
  do {
    p = p < 0 ? -p : len - 1 - (p - len) - 1
  } while (p < 0 || p >= len)
  return p
}

const laplacianKernel = [1, -2, 1, -2, 4, -2, 1, -2, 1]

/**
 * homr's estimate_noise on the tile (x, y, w, h) of an 8-bit image: the mean absolute
 * response to a Laplacian-like kernel, with cv2.filter2D's default border on the tile.
 */
function estimateNoise(img: Uint8Array, width: number, x: number, y: number, w: number, h: number): number {
  // The responses are integers, so the sum is exact in any order
  let sum = 0
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      let response = 0
      for (let ky = -1; ky <= 1; ky++) {
        const r = y + reflect101(row + ky, h)
        for (let kx = -1; kx <= 1; kx++) {
          const c = x + reflect101(col + kx, w)
          response += laplacianKernel[(ky + 1) * 3 + kx + 1]! * img[r * width + c]!
        }
      }
      sum += Math.abs(response)
    }
  }
  return sum / (w * h)
}

/** homr's create_noise_grid: a mask of the cells to keep, or undefined to keep everything. */
export function createNoiseMask(gray: Uint8Array, width: number, height: number): Uint8Array | undefined {
  const m = Math.floor(height / 20)
  const n = Math.floor(width / 20)
  const rows = Math.ceil(height / m)
  const cols = Math.ceil(width / n)
  // The grid is uint8: numpy truncates the noise, and like a C cast on x86 wraps values above 255
  const grid = new Uint8Array(rows * cols)
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const y = i * m
      const x = j * n
      const noise = estimateNoise(gray, width, x, y, Math.min(n, width - x), Math.min(m, height - y))
      grid[i * cols + j] = Math.trunc(noise) & 255
    }
  }

  const mask = new Uint8Array(width * height)
  let filtered = 0
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const neighbors: number[] = []
      if (i > 0) neighbors.push(grid[(i - 1) * cols + j]!)
      if (j > 0) neighbors.push(grid[i * cols + j - 1]!)
      if (i < rows - 1) neighbors.push(grid[(i + 1) * cols + j]!)
      if (j < cols - 1) neighbors.push(grid[i * cols + j + 1]!)
      const noisy = grid[i * cols + j]! > imageNoiseLimit && neighbors.some((v) => v > imageNoiseLimit)
      if (noisy) {
        filtered++
      } else {
        for (let y = i * m; y < Math.min((i + 1) * m, height); y++) {
          mask.fill(255, y * width + j * n, y * width + Math.min((j + 1) * n, width))
        }
      }
    }
  }
  if (filtered / (rows * cols) > 0.5) return undefined // would filter more than half the image
  return filtered > 0 ? mask : undefined
}

function applyMask<T extends { data: Uint8Array }>(image: T, mask: Uint8Array, channels = 1): T {
  const data = image.data.slice()
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0) data.fill(0, i * channels, (i + 1) * channels)
  }
  return { ...image, data }
}

export function filterPredictions(p: InputPredictions): InputPredictions {
  const staff255 = p.staff.data.map((v) => v * 255)
  const mask = createNoiseMask(staff255, p.staff.width, p.staff.height)
  if (!mask) return p
  const m = (x: Mask) => applyMask(x, mask)
  return {
    original: applyMask(p.original, mask, 3),
    preprocessed: applyMask(p.preprocessed, mask),
    notehead: m(p.notehead),
    symbols: m(p.symbols),
    staff: m(p.staff),
    clefsKeys: m(p.clefsKeys),
    stemsRest: m(p.stemsRest),
  }
}
