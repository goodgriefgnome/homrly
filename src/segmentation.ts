// Port of homr/segmentation/inference_segnet.py (inference, extract_patch, merge_patches).
import * as ort from 'onnxruntime-web'
import type { GrayImage } from './image.js'

/** The classes segnet assigns to each pixel. */
export const SegmentationClass = {
  background: 0,
  stemsRests: 1,
  notehead: 2,
  clefsKeys: 3,
  staff: 4,
  symbols: 5,
} as const

const classCount = 6

/** One class per pixel, row-major. */
export interface ClassMap {
  width: number
  height: number
  data: Uint8Array
}

export interface SegmentationOptions {
  batchSize?: number
  /** How far the window moves between tiles. homr's pipeline uses 320, the window size. */
  stepSize?: number
  winSize?: number
}

/** Top-left corners of the tiles in the order homr runs them. Coordinates can be negative. */
export function tileOrigins(
  height: number,
  width: number,
  stepSize: number,
  winSize: number,
): Array<[number, number]> {
  const origins: Array<[number, number]> = []
  for (let yLoop = 0; yLoop < Math.max(height, winSize); yLoop += stepSize) {
    const y = Math.min(yLoop, height - winSize)
    for (let xLoop = 0; xLoop < Math.max(width, winSize); xLoop += stepSize) {
      origins.push([y, Math.min(xLoop, width - winSize)])
    }
  }
  return origins
}

/** Copies a tile into `out` as 3 identical channels, padding with white past the image. */
function extractTile(image: GrayImage, y: number, x: number, winSize: number, out: Float32Array) {
  const plane = winSize * winSize
  out.fill(255, 0, 3 * plane)
  const y0 = Math.max(y, 0)
  const x0 = Math.max(x, 0)
  const y1 = Math.min(y + winSize, image.height)
  const x1 = Math.min(x + winSize, image.width)
  // Like homr, the visible part goes to the tile's top-left even when y or x is negative
  for (let row = 0; row < y1 - y0; row++) {
    const src = (y0 + row) * image.width + x0
    for (let col = 0; col < x1 - x0; col++) {
      const v = image.data[src + col]!
      const i = row * winSize + col
      out[i] = v
      out[plane + i] = v
      out[2 * plane + i] = v
    }
  }
}

/** Per-pixel argmax over the class channels of one tile of segnet's output. */
function argmaxTile(output: Float32Array, offset: number, winSize: number): Uint8Array {
  const plane = winSize * winSize
  const result = new Uint8Array(plane)
  for (let i = 0; i < plane; i++) {
    let best = 0
    let bestValue = output[offset + i]!
    for (let c = 1; c < classCount; c++) {
      const value = output[offset + c * plane + i]!
      // Strictly greater: ties go to the first class, as with numpy's argmax
      if (value > bestValue) {
        bestValue = value
        best = c
      }
    }
    result[i] = best
  }
  return result
}

/**
 * Port of homr's merge_patches. Overlapping tiles are averaged and truncated to an integer
 * class, as homr does. Its loop runs over the image size rather than max(size, winSize) like
 * the tiling loop; that is kept so results match for images smaller than one tile.
 */
export function mergeTiles(
  tiles: Uint8Array[],
  height: number,
  width: number,
  winSize: number,
  stepSize: number,
): ClassMap {
  const sum = new Float32Array(height * width)
  const weight = new Float32Array(height * width)
  let idx = 0
  for (let iy = 0; iy < height; iy += stepSize) {
    const y = Math.min(iy, height - winSize)
    const y0 = Math.max(y, 0)
    const y1 = Math.min(y + winSize, height)
    for (let ix = 0; ix < width; ix += stepSize) {
      const x = Math.min(ix, width - winSize)
      const x0 = Math.max(x, 0)
      const x1 = Math.min(x + winSize, width)
      const tile = tiles[idx++]
      if (!tile) throw new Error(`Tile ${idx - 1} is missing`)
      for (let row = 0; row < y1 - y0; row++) {
        for (let col = 0; col < x1 - x0; col++) {
          const i = (y0 + row) * width + x0 + col
          sum[i]! += tile[row * winSize + col]!
          weight[i]! += 1
        }
      }
    }
  }
  const data = new Uint8Array(height * width)
  for (let i = 0; i < data.length; i++) {
    const w = weight[i] === 0 ? 1 : weight[i]!
    data[i] = Math.trunc(Math.fround(sum[i]! / w))
  }
  return { width, height, data }
}

/**
 * Runs segnet over a grayscale image (homr feeds it the CLAHE-adjusted image)
 * and returns the class of every pixel.
 */
export async function segment(
  session: ort.InferenceSession,
  image: GrayImage,
  { batchSize = 8, stepSize = 320, winSize = 320 }: SegmentationOptions = {},
): Promise<ClassMap> {
  const origins = tileOrigins(image.height, image.width, stepSize, winSize)
  const tileSize = 3 * winSize * winSize
  const tiles: Uint8Array[] = []
  for (let start = 0; start < origins.length; start += batchSize) {
    const batch = origins.slice(start, start + batchSize)
    const input = new Float32Array(batch.length * tileSize)
    batch.forEach(([y, x], i) =>
      extractTile(image, y, x, winSize, input.subarray(i * tileSize, (i + 1) * tileSize)),
    )
    const feeds = { input: new ort.Tensor('float32', input, [batch.length, 3, winSize, winSize]) }
    const results = await session.run(feeds)
    const output = results.output!.data as Float32Array
    for (let i = 0; i < batch.length; i++) {
      tiles.push(argmaxTile(output, i * classCount * winSize * winSize, winSize))
    }
    for (const tensor of Object.values(results)) tensor.dispose()
  }
  return mergeTiles(tiles, image.height, image.width, winSize, stepSize)
}

/** A 0/1 mask of the pixels of one class, like homr's `(merged == k).astype(np.uint8)`. */
export function classMask(map: ClassMap, cls: number): Uint8Array {
  const mask = new Uint8Array(map.data.length)
  for (let i = 0; i < mask.length; i++) mask[i] = map.data[i] === cls ? 1 : 0
  return mask
}
