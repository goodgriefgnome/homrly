/** An 8-bit grayscale image, row-major. */
export interface GrayImage {
  width: number
  height: number
  data: Uint8Array
}

/** Converts RGBA pixels (e.g. browser ImageData) to grayscale with OpenCV's BGR2GRAY weights. */
export function rgbaToGray(rgba: { width: number; height: number; data: ArrayLike<number> }): GrayImage {
  const { width, height } = rgba
  const data = new Uint8Array(width * height)
  for (let i = 0; i < data.length; i++) {
    const r = rgba.data[4 * i]!
    const g = rgba.data[4 * i + 1]!
    const b = rgba.data[4 * i + 2]!
    // OpenCV rounds 0.299 R + 0.587 G + 0.114 B with 14-bit fixed-point weights
    data[i] = (r * 4899 + g * 9617 + b * 1868 + 8192) >> 14
  }
  return { width, height, data }
}
