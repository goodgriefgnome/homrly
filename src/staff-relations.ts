// Port of homr/staff_relations.py: decides how neighboring staffs relate with two small
// CNNs, which look at crops that follow the staff lines.
import * as ort from 'onnxruntime-web'
import { cvSync, withMats, type Mat } from './cv.js'
import { MultiStaff, Staff, StaffPoint } from './model.js'
import type { Models } from './models.js'
import { median, pyRound } from './np.js'
import type { InputPredictions } from './predictions.js'

export const SEPARATE = 0
export const SAME_SYSTEM = 1
export const GRAND_STAFF = 2
export const CLASSES = ['separate', 'same system', 'grand staff']
// Probability above which the model is sure that two staffs are in the same system
const certainProbability = 0.9

// Resolution of the crops in pixels per unit size (distance of two staff lines)
const pixelsPerUnit = 4
// Units left of the staffs and of the start of the staffs in the crop
const marginUnits = 10
const startUnits = 14
// Rows of the crop: 3 units above, upper staff, gap, lower staff, 3 units below
const staffRows = 16
const outerRows = 12
const gapRows = 40
const cropHeight = 2 * (outerRows + staffRows) + gapRows
const cropWidth = (marginUnits + startUnits) * pixelsPerUnit
const channels = 5

/** np.interp(x, xs, ys) for increasing xs. */
export function interp(x: number, xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  const n = xs.length
  if (x < xs[0]!) return ys[0]!
  if (x > xs[n - 1]!) return ys[n - 1]!
  if (x === xs[n - 1]) return ys[n - 1]!
  // The j with xs[j] <= x < xs[j + 1]
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xs[mid]! <= x) lo = mid
    else hi = mid
  }
  const slope = (ys[lo + 1]! - ys[lo]!) / (xs[lo + 1]! - xs[lo]!)
  let result = slope * (x - xs[lo]!) + ys[lo]!
  if (Number.isNaN(result)) {
    result = slope * (x - xs[lo + 1]!) + ys[lo + 1]!
    if (Number.isNaN(result) && ys[lo] === ys[lo + 1]) result = ys[lo]!
  }
  return result
}

/** The y of a staff line at x, constant beyond the ends of the staff. -1 is the last line. */
function lineAt(staff: Staff, line: number, x: number): number {
  const xs = staff.grid.map((p) => p.x)
  const ys = staff.grid.map((p) => p.y.at(line)!)
  return interp(x, xs, ys)
}

/**
 * The image and the segmentation as channels in [0, 1], scaled down to pixelsPerUnit:
 * channels 0-3 in one 4-channel Mat and channel 4 in another, as cv2.remap handles at
 * most 4 channels. Free them with release().
 */
export class PageChannels {
  private constructor(
    readonly first4: Mat,
    readonly last: Mat,
    readonly scale: number,
  ) {}

  static create(predictions: InputPredictions, unitSize: number): PageChannels {
    const cv = cvSync()
    const scale = Math.min(1, pixelsPerUnit / unitSize)
    const { width, height } = predictions.preprocessed
    const layers = [
      predictions.preprocessed.data.map((v) => 255 - v),
      predictions.staff.data.map((v) => v * 255),
      predictions.symbols.data.map((v) => v * 255),
      predictions.stemsRest.data.map((v) => v * 255),
      predictions.clefsKeys.data.map((v) => v * 255),
    ]
    const size = new cv.Size(Math.max(1, pyRound(width * scale)), Math.max(1, pyRound(height * scale)))
    const scaled = layers.map((layer) =>
      withMats(cv, (s) => {
        const out = s.empty()
        cv.resize(s.fromU8(layer, width, height, 1), out, size, 0, 0, cv.INTER_AREA)
        return new Uint8Array(out.data)
      }),
    )
    const m = size.width * size.height
    const first4 = new cv.Mat(size.height, size.width, cv.CV_32FC4)
    const last = new cv.Mat(size.height, size.width, cv.CV_32FC1)
    const f4: Float32Array = first4.data32F
    const f1: Float32Array = last.data32F
    for (let i = 0; i < m; i++) {
      for (let c = 0; c < 4; c++) f4[4 * i + c] = scaled[c]![i]! / 255
      f1[i] = scaled[4]![i]! / 255
    }
    return new PageChannels(first4, last, scale)
  }

  /**
   * cv2.remap of all channels at the given page coordinates (before scaling), as
   * (channels, height, width) float32 written into `out`.
   */
  remap(mapX: Float64Array, mapY: Float64Array, height: number, width: number, out: Float32Array): void {
    const cv = cvSync()
    withMats(cv, (s) => {
      const mx = s.track(new cv.Mat(height, width, cv.CV_32FC1))
      const my = s.track(new cv.Mat(height, width, cv.CV_32FC1))
      const fx: Float32Array = mx.data32F
      const fy: Float32Array = my.data32F
      for (let i = 0; i < height * width; i++) {
        fx[i] = mapX[i]! * this.scale
        fy[i] = mapY[i]! * this.scale
      }
      const plane = height * width
      const r4 = s.empty()
      cv.remap(this.first4, r4, mx, my, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0))
      const d4: Float32Array = r4.data32F
      for (let i = 0; i < plane; i++) for (let c = 0; c < 4; c++) out[c * plane + i] = d4[4 * i + c]!
      const r1 = s.empty()
      cv.remap(this.last, r1, mx, my, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0))
      out.set(r1.data32F as Float32Array, 4 * plane)
    })
  }

  release(): void {
    this.first4.delete()
    this.last.delete()
  }
}

/** Rows (anchor row -> y, linear in between) for each column, row-major. */
function interpolateRows(anchorRows: number[], anchorYs: Float64Array[], columns: number, out: Float64Array): void {
  for (let i = 0; i < anchorRows.length - 1; i++) {
    const start = anchorRows[i]!
    const end = anchorRows[i + 1]!
    for (let r = start; r < end; r++) {
      const share = (r - start) / (end - start)
      for (let c = 0; c < columns; c++) {
        const a = anchorYs[i]![c]!
        out[r * columns + c] = a + share * (anchorYs[i + 1]![c]! - a)
      }
    }
  }
}

const cumsum = (a: number[]) => a.map(((sum) => (v: number) => (sum += v))(0))

/** The left margin and the start of two vertically neighboring staffs. */
function pairCrop(page: PageChannels, upper: Staff, lower: Staff, out: Float32Array): void {
  const unit = (upper.averageUnitSize + lower.averageUnitSize) / 2
  const left = Math.min(upper.minX, lower.minX)
  const x = Float64Array.from({ length: cropWidth }, (_, i) => left + (i / pixelsPerUnit - marginUnits) * unit)
  const at = (staff: Staff, line: number) => x.map((v) => lineAt(staff, line, v))
  const upperTop = at(upper, 0)
  const upperBottom = at(upper, -1)
  const lowerTop = at(lower, 0)
  const lowerBottom = at(lower, -1)
  const anchorYs = [
    upperTop.map((v) => v - 3 * unit),
    upperTop,
    upperBottom,
    lowerTop,
    lowerBottom,
    lowerBottom.map((v) => v + 3 * unit),
  ]
  const rows = new Float64Array(cropHeight * cropWidth)
  interpolateRows(cumsum([0, outerRows, staffRows, gapRows, staffRows, outerRows]), anchorYs, cropWidth, rows)
  const mapX = new Float64Array(cropHeight * cropWidth)
  for (let r = 0; r < cropHeight; r++) mapX.set(x, r * cropWidth)
  page.remap(mapX, rows, cropHeight, cropWidth, out)
}

function overlapsHorizontally(upper: Staff, lower: Staff): boolean {
  const overlap = Math.min(upper.maxX, lower.maxX) - Math.max(upper.minX, lower.minX)
  return overlap > 0.3 * Math.min(upper.maxX - upper.minX, lower.maxX - lower.minX)
}

/** Each staff with the next staff below it, among those which overlap horizontally. */
export function verticalPairs(staffs: Staff[]): Array<[number, number]> {
  const order = staffs.map((_, i) => i).sort((a, b) => staffs[a]!.minY - staffs[b]!.minY)
  const pairs: Array<[number, number]> = []
  order.forEach((i, position) => {
    const below = order
      .slice(position + 1)
      .filter((j) => overlapsHorizontally(staffs[i]!, staffs[j]!) && staffs[j]!.minY > staffs[i]!.minY)
    if (below.length > 0) {
      let best = below[0]!
      for (const j of below) if (staffs[j]!.minY < staffs[best]!.minY) best = j
      pairs.push([i, best])
    }
  })
  return pairs
}

/** Softmax over the classes of each row, like StaffRelationModel.predict. */
function softmax(logits: Float32Array, classes: number): number[][] {
  const result: number[][] = []
  for (let k = 0; k < logits.length / classes; k++) {
    const row = Array.from(logits.subarray(k * classes, (k + 1) * classes))
    const max = Math.max(...row)
    const exp = row.map((v) => Math.fround(Math.exp(Math.fround(v - max))))
    const sum = exp.reduce((a, b) => Math.fround(a + b), 0)
    result.push(exp.map((v) => Math.fround(v / sum)))
  }
  return result
}

/** The vertical pairs of a page and the model's probabilities for them. */
export async function predictVerticalRelations(
  models: Models,
  predictions: InputPredictions,
  staffs: Staff[],
): Promise<{ pairs: Array<[number, number]>; probabilities: number[][] }> {
  const pairs = verticalPairs(staffs)
  if (pairs.length === 0) return { pairs, probabilities: [] }
  const unit = median(staffs.map((s) => s.averageUnitSize))
  const page = PageChannels.create(predictions, unit)
  const size = channels * cropHeight * cropWidth
  const crops = new Float32Array(pairs.length * size)
  try {
    pairs.forEach(([i, j], k) => pairCrop(page, staffs[i]!, staffs[j]!, crops.subarray(k * size, (k + 1) * size)))
  } finally {
    page.release()
  }
  const session = await models.session('staffRelations')
  const output = await session.run({ crop: new ort.Tensor('float32', crops, [pairs.length, channels, cropHeight, cropWidth]) })
  return { pairs, probabilities: softmax(output.logits!.data as Float32Array, CLASSES.length) }
}

/** Indices of the pairs which form grand staffs; each staff is in at most one. */
function selectGrandStaffs(pairs: Array<[number, number]>, probabilities: number[][]): number[] {
  const candidates = probabilities
    .map((p, k) => [p, k] as const)
    .filter(([p]) => p[GRAND_STAFF] === Math.max(...p) && p[SEPARATE]! < 0.5)
    .map(([, k]) => k)
  const used = new Set<number>()
  const selected: number[] = []
  for (const k of [...candidates].sort((a, b) => probabilities[b]![GRAND_STAFF]! - probabilities[a]![GRAND_STAFF]!)) {
    const [i, j] = pairs[k]!
    if (used.has(i) || used.has(j)) continue
    used.add(i)
    used.add(j)
    selected.push(k)
  }
  return selected
}

/**
 * Staff.merge keeps the x positions which both grids have. If they have fewer than two in
 * common, the lower staff is resampled to the grid of the upper one.
 */
function mergeGrandStaff(upper: Staff, lower: Staff): Staff {
  const upperXs = new Set(upper.grid.map((p) => pyRound(p.x)))
  const common = new Set(lower.grid.map((p) => pyRound(p.x)).filter((x) => upperXs.has(x)))
  if (common.size >= 2) return upper.merge(lower)
  const points = upper.grid.filter((p) => lower.minX <= p.x && p.x <= lower.maxX)
  if (points.length === 0) return upper
  const lineCount = lower.grid[0]!.y.length
  const resampled = new Staff(
    points.map((p) => new StaffPoint(p.x, Array.from({ length: lineCount }, (_, line) => lineAt(lower, line, p.x)), p.angle)),
  )
  resampled.symbols = lower.symbols
  const cut = new Staff(points)
  cut.symbols = upper.symbols
  return cut.merge(resampled)
}

/**
 * Joins the staffs of a pair into one system if the model doesn't see them as separate,
 * and merges the pairs it sees as grand staffs. A system of several staffs is certain if
 * the model is sure that all its pairs belong together.
 */
export function groupStaffs(staffs: Staff[], pairs: Array<[number, number]>, probabilities: number[][]): MultiStaff[] {
  const systemOf = staffs.map((_, i) => i)
  const find = (i: number) => {
    while (systemOf[i] !== i) i = systemOf[i]!
    return i
  }
  pairs.forEach(([i, j], k) => {
    if (probabilities[k]![SEPARATE]! < 0.5) systemOf[find(j)] = find(i)
  })
  const grandStaffs = new Map<number, number>()
  for (const k of selectGrandStaffs(pairs, probabilities)) grandStaffs.set(pairs[k]![0], pairs[k]![1])
  const lowerStaffs = new Set(grandStaffs.values())
  const systems = new Map<number, Staff[]>()
  staffs.forEach((staff, i) => {
    if (lowerStaffs.has(i)) return
    if (grandStaffs.has(i)) staff = mergeGrandStaff(staff, staffs[grandStaffs.get(i)!]!)
    const root = find(i)
    if (!systems.has(root)) systems.set(root, [])
    systems.get(root)!.push(staff)
  })
  const uncertain = new Set<number>()
  pairs.forEach(([i, j], k) => {
    if (find(i) === find(j) && probabilities[k]![SEPARATE]! > 1 - certainProbability) uncertain.add(find(i))
  })
  const result = [...systems.entries()].map(
    ([root, system]) => new MultiStaff(system, [], system.length > 1 && !uncertain.has(root)),
  )
  return result.sort((a, b) => a.staffs[0]!.minY - b.staffs[0]!.minY)
}

// Horizontal pairs: two staffs in the same row, which can be pieces of one staff
const SAME_STAFF = 1
// Columns of the end of the left staff, of the gap and of the start of the right staff
const endUnits = 16
const horizontalEndWidth = endUnits * pixelsPerUnit
const horizontalGapWidth = 64
const horizontalCropWidth = 2 * horizontalEndWidth + horizontalGapWidth
const horizontalCropHeight = 2 * outerRows + staffRows
const horizontalFeatures = 5

/** Least-squares line through the points: [slope, intercept], like np.polyfit(x, y, 1). */
function fitLine(xs: number[], ys: number[]): [number, number] {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my)
    sxx += (xs[i]! - mx) ** 2
  }
  const slope = sxy / sxx
  return [slope, my - slope * mx]
}

/** The y of the center line at x, extrapolated along the last 20 units beyond the ends. */
function centerAt(staff: Staff, x: number): number {
  const xs = staff.grid.map((p) => p.x)
  const ys = staff.grid.map((p) => (p.y[0]! + p.y[p.y.length - 1]!) / 2)
  const first = xs[0]!
  const last = xs[xs.length - 1]!
  if ((first <= x && x <= last) || xs.length < 2) return interp(x, xs, ys)
  const reach = 20 * staff.averageUnitSize
  let near = xs.map((v) => (x > last ? v >= last - reach : v <= first + reach))
  if (near.filter(Boolean).length < 2) {
    near = xs.map((_, i) => (x > last ? i >= xs.length - 2 : i < 2))
  }
  const [slope, intercept] = fitLine(
    xs.filter((_, i) => near[i]),
    ys.filter((_, i) => near[i]),
  )
  return slope * x + intercept
}

/** Vertical offset of the right staff, both extrapolated to the middle of the gap. */
function offset(left: Staff, right: Staff): number {
  const middle = (left.maxX + right.minX) / 2
  return centerAt(right, middle) - centerAt(left, middle)
}

/** The right staff starts right of the start of the left one, at about the same height. */
function isSameRow(left: Staff, right: Staff): boolean {
  if (right.minX <= left.minX || right.maxX <= left.maxX) return false
  const unit = (left.averageUnitSize + right.averageUnitSize) / 2
  return Math.abs(offset(left, right)) < 4 * unit
}

/** Each staff with the closest staff right of it in the same row. */
export function horizontalPairs(staffs: Staff[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  staffs.forEach((left, i) => {
    const right = staffs.map((_, j) => j).filter((j) => j !== i && isSameRow(left, staffs[j]!))
    if (right.length > 0) {
      let best = right[0]!
      for (const j of right) if (staffs[j]!.minX < staffs[best]!.minX) best = j
      pairs.push([i, best])
    }
  })
  return pairs
}

const linspace = (a: number, b: number, n: number) =>
  Float64Array.from({ length: n }, (_, i) => (i === n - 1 ? b : a + ((b - a) / (n - 1)) * i))

/** The end of the left staff, the gap and the start of the right staff. */
function horizontalCrop(page: PageChannels, left: Staff, right: Staff, out: Float32Array): void {
  const unit = (left.averageUnitSize + right.averageUnitSize) / 2
  const share = Float64Array.from({ length: horizontalEndWidth }, (_, i) => i / horizontalEndWidth)
  const x = Float64Array.from([
    ...share.map((s) => left.maxX + (s - 1) * endUnits * unit),
    ...linspace(left.maxX, right.minX, horizontalGapWidth),
    ...share.map((s) => right.minX + s * endUnits * unit),
  ])
  const blend = Float64Array.from([
    ...new Array<number>(horizontalEndWidth).fill(0),
    ...linspace(0, 1, horizontalGapWidth),
    ...new Array<number>(horizontalEndWidth).fill(1),
  ])
  const tops = x.map((v, i) => (1 - blend[i]!) * lineAt(left, 0, v) + blend[i]! * lineAt(right, 0, v))
  const bottoms = x.map((v, i) => (1 - blend[i]!) * lineAt(left, -1, v) + blend[i]! * lineAt(right, -1, v))
  const anchorYs = [tops.map((v) => v - 3 * unit), tops, bottoms, bottoms.map((v) => v + 3 * unit)]
  const rows = new Float64Array(horizontalCropHeight * x.length)
  interpolateRows(cumsum([0, outerRows, staffRows, outerRows]), anchorYs, x.length, rows)
  const mapX = new Float64Array(rows.length)
  for (let r = 0; r < horizontalCropHeight; r++) mapX.set(x, r * x.length)
  page.remap(mapX, rows, horizontalCropHeight, x.length, out)
}

function horizontalPairFeatures(left: Staff, right: Staff): number[] {
  const unit = (left.averageUnitSize + right.averageUnitSize) / 2
  return [
    offset(left, right) / unit,
    (right.minX - left.maxX) / unit / 10,
    Math.log(left.averageUnitSize / right.averageUnitSize),
    (left.maxX - left.minX) / unit / 100,
    (right.maxX - right.minX) / unit / 100,
  ]
}

/** One staff from two pieces in a row; where they overlap the left one is used. */
function joinPieces(left: Staff, right: Staff): Staff {
  const joined = new Staff([...left.grid, ...right.grid.filter((p) => p.x > left.maxX)])
  joined.symbols = [...left.symbols, ...right.symbols]
  return joined
}

/** Joins the pairs which the model sees as pieces of the same staff. */
export function joinStaffPieces(staffs: Staff[], pairs: Array<[number, number]>, probabilities: number[][]): Staff[] {
  const rightOf = new Map<number, number>()
  pairs.forEach(([i, j], k) => {
    if (probabilities[k]![SAME_STAFF]! > 0.5) rightOf.set(i, j)
  })
  const used = new Set<number>()
  const result: Staff[] = []
  for (const i of staffs.map((_, i) => i).sort((a, b) => staffs[a]!.minX - staffs[b]!.minX)) {
    if (used.has(i)) continue
    used.add(i)
    let staff = staffs[i]!
    let j = i
    while (rightOf.get(j) !== undefined && !used.has(rightOf.get(j)!)) {
      j = rightOf.get(j)!
      used.add(j)
      staff = joinPieces(staff, staffs[j]!)
    }
    result.push(staff)
  }
  return result.sort((a, b) => a.minY - b.minY)
}

/** The horizontal pairs with their crops, features and the model's probabilities. */
export async function predictHorizontalRelations(
  models: Models,
  predictions: InputPredictions,
  staffs: Staff[],
): Promise<{ pairs: Array<[number, number]>; crops: Float32Array; feats: Float32Array; probabilities: number[][] }> {
  const pairs = horizontalPairs(staffs)
  if (pairs.length === 0) return { pairs, crops: new Float32Array(0), feats: new Float32Array(0), probabilities: [] }
  const unit = median(staffs.map((s) => s.averageUnitSize))
  const page = PageChannels.create(predictions, unit)
  const size = channels * horizontalCropHeight * horizontalCropWidth
  const crops = new Float32Array(pairs.length * size)
  const feats = new Float32Array(pairs.length * horizontalFeatures)
  try {
    pairs.forEach(([i, j], k) => {
      horizontalCrop(page, staffs[i]!, staffs[j]!, crops.subarray(k * size, (k + 1) * size))
      feats.set(horizontalPairFeatures(staffs[i]!, staffs[j]!), k * horizontalFeatures)
    })
  } finally {
    page.release()
  }
  const session = await models.session('staffPieces')
  const output = await session.run({
    crop: new ort.Tensor('float32', crops, [pairs.length, channels, horizontalCropHeight, horizontalCropWidth]),
    features: new ort.Tensor('float32', feats, [pairs.length, horizontalFeatures]),
  })
  return { pairs, crops, feats, probabilities: softmax(output.logits!.data as Float32Array, 2) }
}

/** Joins staffs which the model sees as pieces of one staff. */
export async function joinPiecesWithModel(models: Models, predictions: InputPredictions, staffs: Staff[]): Promise<Staff[]> {
  const { pairs, probabilities } = await predictHorizontalRelations(models, predictions, staffs)
  if (pairs.length === 0) return staffs
  return joinStaffPieces(staffs, pairs, probabilities)
}

/** Port of main.group_staffs. */
export async function groupStaffsWithModels(
  models: Models,
  predictions: InputPredictions,
  staffs: Staff[],
): Promise<MultiStaff[]> {
  const joined = await joinPiecesWithModel(models, predictions, staffs)
  const { pairs, probabilities } = await predictVerticalRelations(models, predictions, joined)
  return groupStaffs(joined, pairs, probabilities)
}
