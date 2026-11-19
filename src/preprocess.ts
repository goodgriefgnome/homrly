// Port of the preprocessing in homr/main.py (load_and_preprocess_predictions),
// homr/resize.py and homr/color_adjust.py.
import { autocrop } from './autocrop.js'
import { withMats, type CV } from './cv.js'
import { bgrToGray, type BgrImage, type GrayImage } from './image.js'
import { resizeBicubic } from './pil-resize.js'
import { chain, undoCrop, undoResize, type PointMapping } from './point-mapping.js'

const targetWidth = 1920

/** Python's round(): halves go to the even neighbour. */
export function roundHalfEven(x: number): number {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

/** homr's calc_target_image_size: a fixed width, preserving the aspect ratio. */
export function targetImageSize(width: number, height: number): [number, number] {
  if (width === targetWidth) return [width, height]
  return [targetWidth, roundHalfEven(height * (targetWidth / width))]
}

/** homr's resize_image, which resizes with Pillow's default bicubic filter. */
export function resizeImage(image: BgrImage): BgrImage {
  const [w, h] = targetImageSize(image.width, image.height)
  if (w === image.width && h === image.height) return image
  return { width: w, height: h, data: resizeBicubic(image.data, image.width, image.height, 3, w, h) }
}

/** homr's apply_clahe: grayscale, then CLAHE with clip limit 1 on an 8x8 grid. */
export function applyClahe(cv: CV, image: BgrImage): GrayImage {
  const gray = bgrToGray(image)
  return withMats(cv, (s) => {
    const out = s.empty()
    const clahe = new cv.CLAHE(1.0, new cv.Size(8, 8))
    try {
      clahe.apply(s.fromU8(gray.data, gray.width, gray.height, 1), out)
    } finally {
      clahe.delete()
    }
    return { width: gray.width, height: gray.height, data: new Uint8Array(out.data) }
  })
}

export interface Preprocessed {
  /** The cropped and resized color image. */
  original: BgrImage
  /** The grayscale, contrast-adjusted image that segmentation runs on. */
  preprocessed: GrayImage
  /** Takes points in the preprocessed image back to the input image. */
  toInputImage: PointMapping
}

export function preprocess(cv: CV, input: BgrImage): Preprocessed {
  const { image: cropped, offset } = autocrop(cv, input)
  const original = resizeImage(cropped)
  const preprocessed = applyClahe(cv, original)
  return {
    original,
    preprocessed,
    toInputImage: chain(undoResize(cropped, preprocessed), undoCrop(...offset)),
  }
}
