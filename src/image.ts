/** An 8-bit grayscale image, row-major. */
export interface GrayImage {
  width: number
  height: number
  data: Uint8Array
}

/** An 8-bit color image with interleaved B, G, R channels, as OpenCV and homr use them. */
export interface BgrImage {
  width: number
  height: number
  data: Uint8Array
}

/** Pixels as the browser gives them, e.g. ImageData: interleaved R, G, B, A. */
export interface RgbaPixels {
  width: number
  height: number
  data: ArrayLike<number>
}

/** Drops alpha and reorders RGBA to BGR, like reading an opaque image with cv2.imread. */
export function rgbaToBgr({ width, height, data }: RgbaPixels): BgrImage {
  const out = new Uint8Array(width * height * 3)
  for (let i = 0, j = 0; j < out.length; i += 4, j += 3) {
    out[j] = data[i + 2]!
    out[j + 1] = data[i + 1]!
    out[j + 2] = data[i]!
  }
  return { width, height, data: out }
}

/** Converts BGR to grayscale exactly like cv2.cvtColor(..., COLOR_BGR2GRAY) on 8-bit images. */
export function bgrToGray({ width, height, data }: BgrImage): GrayImage {
  const out = new Uint8Array(width * height)
  for (let i = 0; i < out.length; i++) {
    // OpenCV's fixed-point weights for 0.114 B + 0.587 G + 0.299 R, 14 fractional bits
    out[i] = (data[3 * i]! * 1868 + data[3 * i + 1]! * 9617 + data[3 * i + 2]! * 4899 + 8192) >> 14
  }
  return { width, height, data: out }
}

/** Converts RGBA pixels (e.g. browser ImageData) to grayscale like OpenCV does. */
export function rgbaToGray(rgba: RgbaPixels): GrayImage {
  return bgrToGray(rgbaToBgr(rgba))
}

/** A copy of the rectangle (x, y, w, h) of a BGR image. */
export function cropBgr(image: BgrImage, x: number, y: number, w: number, h: number): BgrImage {
  const out = new Uint8Array(w * h * 3)
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * image.width + x) * 3
    out.set(image.data.subarray(src, src + w * 3), row * w * 3)
  }
  return { width: w, height: h, data: out }
}
