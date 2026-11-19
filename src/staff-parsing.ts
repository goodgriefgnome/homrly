// Port of homr/staff_parsing.py, staff_regions.py and staff_parsing_tromr.py: cuts every
// staff out of the page, straightens it and reads its symbols with the transformer.
import { cvSync, withMats } from './cv.js'
import { dewarpStaffImage, type StaffDewarping } from './dewarping.js'
import type { GrayImage } from './image.js'
import type { MultiStaff, Staff } from './model.js'
import type { Models } from './models.js'
import { chain, identity, undoCrop, undoResize, type PointMapping } from './point-mapping.js'
import { layoutOf } from './system-repair.js'
import { maxHeight, maxWidth, readStaff } from './transformer.js'
import { restoreUnmarkedTriplets } from './triplet-restoration.js'
import { EncodedSymbol, isUpperOrHasNoPosition, removeDuplicatedSymbols } from './vocabulary.js'

/** Python's round() on floats: halves to even. */
function roundHalfEven(x: number): number {
  const r = Math.round(x)
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
}

export class StaffRegions {
  private readonly centers: Array<[number, number]>

  constructor(staffs: MultiStaff[]) {
    this.centers = staffs.flatMap((ms) => ms.staffs.map((s): [number, number] => [s.minY, s.maxY]))
  }

  startOfClosestStaffAbove(y: number): number {
    const above = this.centers.filter((c) => c[0] < y).map((c) => c[1])
    return above.length === 0 ? 0 : Math.max(...above)
  }

  startOfClosestStaffBelow(y: number): number {
    const below = this.centers.filter((c) => c[1] > y).map((c) => c[0])
    // larger than the height of every reasonable image
    return below.length === 0 ? 1e12 : Math.min(...below)
  }
}

/** The size [width, height] which fits into the transformer's canvas, keeping the aspect ratio. */
export function trOmrCanvasSize(height: number, width: number, marginTop = 0, marginBottom = 0): [number, number] {
  const maxHeightWithMargin = maxHeight - marginTop - marginBottom
  const ratio = maxHeightWithMargin / maxWidth
  if (height / width > ratio) return [Math.trunc((width / height) * maxHeightWithMargin), maxHeightWithMargin]
  return [maxWidth, Math.trunc((height / width) * maxWidth)]
}

function canvasYOffset(resizedHeight: number, marginTop = 0, marginBottom = 0): number {
  const maxHeightWithMargin = maxHeight - marginTop - marginBottom
  return Math.floor((maxHeightWithMargin - resizedHeight) / 2) + marginTop
}

/** cv2.resize with the default bilinear interpolation. */
function resize(image: GrayImage, width: number, height: number): GrayImage {
  const cv = cvSync()
  return withMats(cv, (s) => {
    const out = s.empty()
    cv.resize(s.fromU8(image.data, image.width, image.height, 1), out, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR)
    return { width, height, data: new Uint8Array(out.data) }
  })
}

function centerImageOnCanvas(image: GrayImage, [width, height]: [number, number]): GrayImage {
  const resized = resize(image, width, height)
  const data = new Uint8Array(maxHeight * maxWidth).fill(255)
  const yOffset = canvasYOffset(resized.height)
  // numpy assignment into new_image[y:y+h, 0:w], clipped to the canvas
  for (let y = 0; y < resized.height; y++) {
    const ty = yOffset + y
    if (ty < 0 || ty >= maxHeight) continue
    data.set(resized.data.subarray(y * resized.width, y * resized.width + Math.min(resized.width, maxWidth)), ty * maxWidth)
  }
  return { width: maxWidth, height: maxHeight, data }
}

const limit = (v: number, size: number) => Math.max(0, Math.min(size - 1, roundHalfEven(v)))

/** image_utils.crop_image_and_return_new_top. */
function cropImageAndReturnNewTop(image: GrayImage, x1: number, y1: number, x2: number, y2: number): [GrayImage, [number, number]] {
  const xa = limit(Math.min(x1, x2), image.width)
  const ya = limit(Math.min(y1, y2), image.height)
  const xb = limit(Math.max(x1, x2), image.width)
  const yb = limit(Math.max(y1, y2), image.height)
  const w = Math.max(0, xb - xa)
  const h = Math.max(0, yb - ya)
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) data.set(image.data.subarray((ya + y) * image.width + xa, (ya + y) * image.width + xa + w), y * w)
  return [{ width: w, height: h, data }, [xa, ya]]
}

/** Blanks large dark areas at the edges of the staff image, e.g. the edge of a book. */
function removeBlackContoursAtEdgesOfImage(gray: GrayImage, unitSize: number): GrayImage {
  const cv = cvSync()
  const thresh = gray.data.map((v) => (v > 97 ? 0 : 255)) // 255 - threshold(gray, 97, 255)
  const result = gray.data.slice()
  const threshold = 2 * unitSize
  withMats(cv, (s) => {
    const contours = s.track(new cv.MatVector())
    cv.findContours(s.fromU8(thresh, gray.width, gray.height, 1), contours, s.empty(), cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE)
    for (let i = 0; i < contours.size(); i++) {
      const r = cv.boundingRect(s.track(contours.get(i)))
      const { x, y, width: w, height: h } = r as { x: number; y: number; width: number; height: number }
      if (w < threshold || h < threshold) continue
      if (!(x === 0 || y === 0 || x + w === gray.width || y + h === gray.height)) continue
      let sum = 0
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) sum += thresh[yy * gray.width + xx]!
      if (sum / (w * h) < 127) continue // mostly dark
      for (let yy = y; yy < y + h; yy++) result.fill(255, yy * gray.width + x, yy * gray.width + x + w)
    }
  })
  return { ...gray, data: result }
}

function calculateRegion(staff: Staff, regions: StaffRegions): [number, number, number, number] {
  const u = staff.averageUnitSize
  const xMin = staff.minX - 2 * u
  const xMax = staff.maxX + 2 * u
  const yMin = Math.max(staff.minY - 4 * u, regions.startOfClosestStaffAbove(staff.minY))
  const yMax = Math.min(staff.maxY + 4 * u, regions.startOfClosestStaffBelow(staff.maxY))
  return [Math.trunc(xMin), Math.trunc(yMin), Math.trunc(xMax), Math.trunc(yMax)]
}

/** Applies the transformation of the image to the staff's coordinates. */
function dewarpStaff(staff: Staff, dewarp: StaffDewarping | undefined, region: [number, number], scaling: number): Staff {
  return staff.transformCoordinates(([x, y]) => {
    x -= region[0]
    y -= region[1]
    if (dewarp) [x, y] = dewarp.dewarpPoint([x, y])
    return [x * scaling, y * scaling]
  })
}

export interface PreparedStaff {
  /** The staff image for the transformer, maxWidth x maxHeight. */
  image: GrayImage
  /** The staff in the coordinates of that image (before the dewarping). */
  staff: Staff
  /** From the coordinates of that image back to the page. */
  toPage: PointMapping
}

/** Port of prepare_staff_image. */
export function prepareStaffImage(staff: Staff, page: GrayImage, regions: StaffRegions): PreparedStaff {
  const region = calculateRegion(staff, regions)
  const dimensions = trOmrCanvasSize(Math.trunc(region[3] - region[1]), Math.trunc(region[2] - region[0]))
  let scalingFactor = dimensions[1] / (region[3] - region[1])
  let image = resize(page, Math.trunc(page.width * scalingFactor), Math.trunc(page.height * scalingFactor))
  const undoScaling = undoResize(page, image)
  const scaled = region.map((v) => roundHalfEven(v * scalingFactor))
  const step1 = [scaled[0]! - 10, scaled[1]! - 50, scaled[2]! + 10, scaled[3]! + 50] as const
  let topLeft: [number, number]
  ;[image, topLeft] = cropImageAndReturnNewTop(image, ...step1)
  const undoCrop1 = undoCrop(...topLeft)
  const step2 = [scaled[0]! - topLeft[0], scaled[1]! - topLeft[1], scaled[2]! - topLeft[0], scaled[3]! - topLeft[1]] as const
  const topLeftOnPage: [number, number] = [topLeft[0] / scalingFactor, topLeft[1] / scalingFactor]
  const transformed = dewarpStaff(staff, undefined, topLeftOnPage, scalingFactor)
  const dewarp = dewarpStaffImage(image, transformed)
  image = dewarp.dewarp(image)
  ;[image, topLeft] = cropImageAndReturnNewTop(image, ...step2)
  const undoCrop2 = undoCrop(...topLeft)
  scalingFactor = 1
  image = removeBlackContoursAtEdgesOfImage(image, transformed.averageUnitSize)
  const beforeCanvas = { width: image.width, height: image.height }
  image = centerImageOnCanvas(image, dimensions)
  const canvasContent = { width: dimensions[0], height: dimensions[1] }
  const toPage = chain(
    undoCrop(0, -canvasYOffset(canvasContent.height)),
    undoResize(beforeCanvas, canvasContent),
    undoCrop2,
    (p) => dewarp.undewarpPoint(p),
    undoCrop1,
    undoScaling,
  )
  return { image, staff: transformed, toPage }
}

function symbolCenter(symbol: EncodedSymbol): [number, number] | undefined {
  const c = symbol.coordinates
  if (!c || symbol.rhythm.startsWith('chord')) return undefined
  if (c.length < 2 || Number.isNaN(c[0]) || Number.isNaN(c[1])) return undefined
  return [c[0]!, c[1]!]
}

/** Port of parse_staff_image and staff_parsing_tromr.parse_staff_tromr. */
async function parseStaffImage(
  models: Models,
  staff: Staff,
  page: GrayImage,
  regions: StaffRegions,
  pageToInputImage: PointMapping,
  onStaffImage?: (image: GrayImage) => void,
): Promise<EncodedSymbol[]> {
  const prepared = prepareStaffImage(staff, page, regions)
  onStaffImage?.(prepared.image)
  let result = await readStaff(models, prepared.image)
  if (!prepared.staff.isGrandstaff) result = result.filter((r) => isUpperOrHasNoPosition(r.position))
  for (const symbol of result) {
    const center = symbolCenter(symbol)
    if (center) symbol.imageCoordinates = pageToInputImage(prepared.toPage(center))
  }
  return result
}

/** itertools.combinations(range(n), k). */
function* combinations(n: number, k: number, start = 0, prefix: number[] = []): Generator<number[]> {
  if (prefix.length === k) {
    yield prefix
    return
  }
  for (let i = start; i < n; i++) yield* combinations(n, k, i + 1, [...prefix, i])
}

/** The staffs of the layout which the staffs of a system are, if that is unique. */
function slotsInLayout(row: string, layout: string): number[] | undefined {
  const matches = [...combinations(layout.length, row.length)].filter((slots) =>
    slots.every((slot, i) => layout[slot] === row[i]),
  )
  return matches.length === 1 ? matches[0] : undefined
}

/** For every system the parts (staffs of the largest system) its staffs belong to. */
function assignParts(staffs: MultiStaff[]): number[][] | undefined {
  const layouts = [...new Set(staffs.map(layoutOf))]
  const longest = Math.max(...layouts.map((l) => l.length))
  const largest = layouts.filter((l) => l.length === longest)
  if (largest.length > 1) return undefined
  const result: number[][] = []
  for (const row of staffs) {
    const slots = slotsInLayout(layoutOf(row), largest[0]!)
    if (!slots) return undefined
    result.push(slots)
  }
  return result
}

const startsWithAny = (s: string, prefixes: readonly string[]) => prefixes.some((p) => s.startsWith(p))

/** The clefs, keys or time signatures before the first note or rest, with their chord tokens. */
function leadingSigns(symbols: EncodedSymbol[], prefixes: readonly string[]): EncodedSymbol[] {
  const result: EncodedSymbol[] = []
  for (const symbol of symbols) {
    if (startsWithAny(symbol.rhythm, ['note', 'rest', 'measureRest']) || symbol.rhythm.includes('barline')) break
    if (startsWithAny(symbol.rhythm, prefixes)) {
      const last = result[result.length - 1]
      if (last && startsWithAny(last.rhythm, prefixes)) {
        if ([last, symbol].some((r) => r.rhythm.startsWith('clef'))) result.push(new EncodedSymbol('chord'))
      }
      result.push(symbol)
    }
  }
  return result
}

/** Rests for a staff which is hidden in a system: one per measure of a shown staff. */
function measureRestsLike(symbols: EncodedSymbol[], isGrandstaff: boolean, clefs?: EncodedSymbol[]): EncodedSymbol[] {
  const positions = isGrandstaff ? ['upper', 'lower'] : ['upper']
  const result = [...(clefs ?? [])]
  result.push(...leadingSigns(symbols, ['keySignature', 'timeSignature']).filter((s) => s.rhythm !== 'chord'))
  let inMeasure = false
  for (const symbol of symbols) {
    if (startsWithAny(symbol.rhythm, ['note', 'rest']) && !inMeasure) {
      positions.forEach((position, i) => {
        if (i > 0) result.push(new EncodedSymbol('chord'))
        result.push(new EncodedSymbol('measureRest', undefined, undefined, undefined, undefined, position))
      })
      inMeasure = true
    } else if (symbol.rhythm.includes('barline') || symbol.rhythm.includes('repeat')) {
      result.push(new EncodedSymbol(symbol.rhythm))
      inMeasure = false
    }
  }
  return result
}

const cleanUpVoice = (symbols: EncodedSymbol[]) => restoreUnmarkedTriplets(removeDuplicatedSymbols(symbols))

export interface ParseStaffsOptions {
  /** Maps coordinates on the page back to the image the user gave, for imageCoordinates. */
  pageToInputImage?: PointMapping
  /** Called with each staff image before the transformer reads it, e.g. to show progress. */
  onStaffImage?: (image: GrayImage, index: number) => void
}

/**
 * Port of parse_staffs: reads every staff and joins the symbols into voices. Every staff of
 * a system is a voice, even if it's part of a grand staff.
 */
export async function parseStaffs(
  models: Models,
  staffs: MultiStaff[],
  page: GrayImage,
  { pageToInputImage = identity, onStaffImage }: ParseStaffsOptions = {},
): Promise<EncodedSymbol[][]> {
  let parts = staffs.map((row) => row.staffs.map((_, i) => i))
  if (new Set(staffs.map((s) => s.staffs.length)).size > 1) {
    // The voices are read across systems, a system with fewer staffs hides some
    const assigned = assignParts(staffs)
    if (!assigned) {
      // The layout changes on the page, every staff is read on its own
      staffs = staffs.flatMap((s) => s.breakApart())
      parts = staffs.map(() => [0])
    } else {
      parts = assigned
    }
  }
  const numberOfVoices = Math.max(...staffs.map((s) => s.staffs.length))
  const layout = layoutOf(staffs.find((row) => row.staffs.length === numberOfVoices)!)
  let i = 0
  const results = new Map<string, EncodedSymbol[]>()
  const key = (staffIndex: number, voice: number) => `${staffIndex},${voice}`
  const regions = new StaffRegions(staffs)
  for (let voice = 0; voice < numberOfVoices; voice++) {
    for (let staffIndex = 0; staffIndex < staffs.length; staffIndex++) {
      if (!parts[staffIndex]!.includes(voice)) continue
      const staff = staffs[staffIndex]!.staffs[parts[staffIndex]!.indexOf(voice)]!
      const index = i
      const result = await parseStaffImage(models, staff, page, regions, pageToInputImage, (image) => onStaffImage?.(image, index))
      i++
      if (result.length === 0) continue // an empty staff
      results.set(key(staffIndex, voice), result)
    }
  }
  // sorted(results) in homr: by staff index, then voice
  const sortedKeys = [...results.keys()]
    .map((k) => k.split(',').map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const voices: EncodedSymbol[][] = []
  for (let voice = 0; voice < numberOfVoices; voice++) {
    const forVoice: EncodedSymbol[] = []
    parts.forEach((slots, staffIndex) => {
      let symbols = results.get(key(staffIndex, voice))
      const shown = slots.filter((v) => results.has(key(staffIndex, v))).map((v) => results.get(key(staffIndex, v))!)
      if (!slots.includes(voice) && shown.length > 0) {
        const firstOfVoice = sortedKeys.find(([, v]) => v === voice)
        const clefs = firstOfVoice ? leadingSigns(results.get(key(...firstOfVoice))!, ['clef']) : undefined
        symbols = measureRestsLike(shown[0]!, layout[voice] === '1', clefs)
      }
      if (!symbols) return
      forVoice.push(...symbols, new EncodedSymbol('newline'))
    })
    voices.push(cleanUpVoice(forVoice))
  }
  return voices
}

