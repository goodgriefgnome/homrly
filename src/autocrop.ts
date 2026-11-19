// Port of homr/autocrop.py: finds the sheet of paper in a photo and crops to it.
import { withMats, type CV, type Mat, type MatScope } from './cv.js'
import { bgrToGray, cropBgr, type BgrImage } from './image.js'
import { medianF32, medianInt } from './np.js'

const f = Math.fround

// Light and shadows change the brightness of paper but hardly its color.
// Mixed daylight and lamp light change it at most by this much.
const maxChromaticityDifference = 0.07

type Chromaticity = [number, number, number]

/** Median chromaticity of BGR pixels, like np.median(_chromaticity(pixels), axis=0). */
function medianChromaticity(pixels: Uint8Array): Chromaticity {
  const n = pixels.length / 3
  const channels = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  for (let i = 0; i < n; i++) {
    const b = pixels[3 * i]! + 1
    const g = pixels[3 * i + 1]! + 1
    const r = pixels[3 * i + 2]! + 1
    const sum = b + g + r
    channels[0]![i] = b / sum
    channels[1]![i] = g / sum
    channels[2]![i] = r / sum
  }
  return [medianF32(channels[0]!), medianF32(channels[1]!), medianF32(channels[2]!)]
}

/** Sum of the float32 absolute differences, as numpy computes it for 3 values. */
function chromaticityDistance(b: number, g: number, r: number, paper: Chromaticity): number {
  return f(f(Math.abs(f(b - paper[0])) + Math.abs(f(g - paper[1]))) + Math.abs(f(r - paper[2])))
}

/** The pixels of the rectangle (x, y, w, h), clipped to the image, row by row. */
function region(img: BgrImage, x: number, y: number, w: number, h: number): Uint8Array {
  const x0 = Math.max(0, Math.min(x, img.width))
  const x1 = Math.max(x0, Math.min(x + w, img.width))
  const y0 = Math.max(0, Math.min(y, img.height))
  const y1 = Math.max(y0, Math.min(y + h, img.height))
  return cropBgr(img, x0, y0, x1 - x0, y1 - y0).data
}

function isPaper(pixels: Uint8Array, paper: Chromaticity): boolean {
  if (pixels.length === 0) return true
  const [b, g, r] = medianChromaticity(pixels)
  return chromaticityDistance(b, g, r, paper) <= maxChromaticityDifference
}

/**
 * Extends the box to the image border on every side where the strip beside it is
 * paper, e.g. in a shadow.
 */
function keepSidesWithPaper(
  img: BgrImage,
  [x, y, w, h]: [number, number, number, number],
  paper: Chromaticity,
): [number, number, number, number] {
  // Only the strips beside the box, the corners can contain e.g. a desk at another side
  const keepLeft = isPaper(region(img, 0, y, x, h), paper)
  const keepRight = isPaper(region(img, x + w, y, img.width - (x + w), h), paper)
  const keepTop = isPaper(region(img, x, 0, w, y), paper)
  const keepBottom = isPaper(region(img, x, y + h, w, img.height - (y + h)), paper)
  const left = keepLeft ? 0 : x
  const top = keepTop ? 0 : y
  const right = keepRight ? img.width : x + w
  const bottom = keepBottom ? img.height : y + h
  return [left, top, right - left, bottom - top]
}

/**
 * Removes what is beside the sheet, e.g. the corners of a desk beside a rotated
 * sheet, by filling it with the color of the paper. The sheet itself is unchanged.
 */
function removeSurroundings(
  s: MatScope,
  crop: BgrImage,
  sheet: Mat,
  paper: Uint8Array,
): BgrImage {
  const cv = s.cv
  const { width, height } = crop
  const n = width * height

  const besideSheet = s.track(new cv.Mat(height, width, cv.CV_8UC1, new cv.Scalar(1)))
  const hull = s.empty()
  cv.convexHull(sheet, hull)
  const hulls = s.track(new cv.MatVector())
  hulls.push_back(hull)
  cv.fillPoly(besideSheet, hulls, new cv.Scalar(0))
  const beside: Uint8Array = besideSheet.data

  const paperCount = paper.length / 3
  const paperColor = [0, 1, 2].map((c) => {
    const values = new Uint8Array(paperCount)
    for (let i = 0; i < paperCount; i++) values[i] = paper[3 * i + c]!
    return medianInt(values)
  }) as [number, number, number]
  const paperChromaticity = medianChromaticity(paper)

  // Single pixels are too noisy to compare their color
  const smooth = s.empty()
  cv.blur(s.fromU8(crop.data, width, height, 3), smooth, new cv.Size(7, 7))
  const sm: Uint8Array = smooth.data
  // The color of dark pixels is noise, e.g. ink in a shadow must stay
  const brightThreshold = 0.25 * ((paperColor[0] + paperColor[1] + paperColor[2]) / 3)

  const background = s.track(new cv.Mat(height, width, cv.CV_8UC1, new cv.Scalar(0)))
  const bg: Uint8Array = background.data
  for (let i = 0; i < n; i++) {
    const b = sm[3 * i]!
    const g = sm[3 * i + 1]!
    const r = sm[3 * i + 2]!
    const bright = (b + g + r) / 3 > brightThreshold
    if (!beside[i] || !bright) continue
    const sum = b + g + r + 3
    const distance = chromaticityDistance(f((b + 1) / sum), f((g + 1) / sum), f((r + 1) / sum), paperChromaticity)
    if (distance > maxChromaticityDifference) bg[i] = 1
  }
  // Also the pixels at the edge of the paper, which mix paper and background
  const dilated = s.empty()
  const kernel = s.track(cv.Mat.ones(5, 5, cv.CV_8U))
  cv.dilate(background, dilated, kernel)
  const dil: Uint8Array = dilated.data

  const result = crop.data.slice()
  // numpy's astype(np.uint8) truncates the medians
  const fill = paperColor.map(Math.trunc)
  for (let i = 0; i < n; i++) {
    if (dil[i]! & beside[i]!) {
      result[3 * i] = fill[0]!
      result[3 * i + 1] = fill[1]!
      result[3 * i + 2] = fill[2]!
    }
  }
  return { width, height, data: result }
}

export interface AutocropResult {
  image: BgrImage
  /** Top-left corner of the crop in the input image. */
  offset: [number, number]
}

/**
 * Finds the largest contour on the image, which is expected to be the paper of sheet music,
 * and crops to it. If none is found, the image is assumed to be a full page view of sheet
 * music and is returned as is. Areas beside the paper which have another color than the
 * paper, e.g. a desk, are painted in the paper color.
 */
export function autocrop(cv: CV, img: BgrImage): AutocropResult {
  return withMats(cv, (s) => {
    const { width, height } = img
    const gray = bgrToGray(img)

    // cv2.calcHist([img], [0], ...): the histogram of the blue channel
    const hist = new Uint32Array(256)
    for (let i = 0; i < width * height; i++) hist[img.data[3 * i]!]!++
    let dominant = 0
    for (let v = 1; v < 256; v++) if (hist[v]! > hist[dominant]!) dominant = v

    // cv2.threshold(gray, dominant - 30, 255, THRESH_BINARY)
    const threshValue = dominant - 30
    const thresh = new Uint8Array(width * height)
    for (let i = 0; i < thresh.length; i++) thresh[i] = gray.data[i]! > threshValue ? 255 : 0

    const morph = s.empty()
    cv.morphologyEx(
      s.fromU8(thresh, width, height, 1),
      morph,
      cv.MORPH_CLOSE,
      s.track(cv.Mat.ones(7, 7, cv.CV_8U)),
    )
    cv.morphologyEx(morph, morph, cv.MORPH_ERODE, s.track(cv.Mat.ones(9, 9, cv.CV_8U)))

    // The largest external contour
    const contours = s.track(new cv.MatVector())
    const hierarchy = s.empty()
    cv.findContours(morph, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    let areaThresh = 0
    let bigContour: Mat | undefined
    for (let i = 0; i < contours.size(); i++) {
      const c = s.track(contours.get(i))
      const area = cv.contourArea(c)
      if (area > areaThresh) {
        areaThresh = area
        bigContour = c
      }
    }
    const unchanged = { image: img, offset: [0, 0] as [number, number] }
    if (!bigContour) return unchanged

    const box = cv.boundingRect(bigContour)
    let [x, y, w, h] = [box.x as number, box.y as number, box.width as number, box.height as number]
    // If we can't find a large contour, then we assume that the picture doesn't have page borders
    if (w < width * 0.25 || h < height * 0.25) return unchanged

    // A sample of the paper is enough to know its color: every 10th pixel above the threshold
    const sample: number[] = []
    let count = 0
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        const i = row * width + col
        if (thresh[i]! > 0) {
          if (count % 10 === 0) sample.push(img.data[3 * i]!, img.data[3 * i + 1]!, img.data[3 * i + 2]!)
          count++
        }
      }
    }
    if (sample.length === 0) return unchanged
    const paper = Uint8Array.from(sample)
    const paperChromaticity = medianChromaticity(paper)

    // The contour was eroded, keep a margin so that staffs at the edge of the paper stay
    const margin = Math.max(5, Math.floor(Math.max(width, height) / 100))
    const x0 = Math.max(0, x - margin)
    const y0 = Math.max(0, y - margin)
    const x1 = Math.min(width, x + w + margin)
    const y1 = Math.min(height, y + h + margin)
    ;[x, y, w, h] = keepSidesWithPaper(img, [x0, y0, x1 - x0, y1 - y0], paperChromaticity)
    if (x === 0 && y === 0 && w === width && h === height) return unchanged

    const crop = cropBgr(img, x, y, w, h)
    // big_contour - (x, y)
    const sheet = s.track(bigContour.clone())
    const points: Int32Array = sheet.data32S
    for (let i = 0; i < points.length; i += 2) {
      points[i]! -= x
      points[i + 1]! -= y
    }
    return { image: removeSurroundings(s, crop, sheet, paper), offset: [x, y] }
  })
}
