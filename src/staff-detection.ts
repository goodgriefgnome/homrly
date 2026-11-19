// Port of homr/staff_detection.py.
import { AngledBoundingBox, RotatedBoundingBox, createRotatedBoundingBox } from './bounding-boxes.js'
import { findPeaks } from './find-peaks.js'
import { concatContours, minAreaRect, type Contour } from './geometry.js'
import { Staff, StaffPoint, numberOfLinesOnAStaff } from './model.js'
import { diff, mean, median, pyRound, std } from './np.js'
import type { Mask } from './predictions.js'

/**
 * Wide fragments (large x dimension) which are curved tend to be filtered by later steps.
 * They are split into smaller parts instead, which better follow the angles of the curve.
 */
export function breakWideFragments(fragments: RotatedBoundingBox[], limit = 100): RotatedBoundingBox[] {
  const result: RotatedBoundingBox[] = []
  for (const fragment of fragments) {
    let remaining = fragment
    while (remaining.size[0] > limit) {
      const points: Array<[number, number]> = []
      for (let i = 0; i < remaining.contours.length; i += 2) {
        points.push([remaining.contours[i]!, remaining.contours[i + 1]!])
      }
      const minX = Math.min(...points.map((p) => p[0]))
      // Stable sorts by x, like Python's sorted
      const left = points.filter((p) => p[0] < minX + limit).sort((a, b) => a[0] - b[0])
      const right = points.filter((p) => p[0] >= minX + limit).sort((a, b) => a[0] - b[0])
      if (left.length === 0 || right.length === 0) break
      // Keep the parts connected: the first point of the right side goes to the left side,
      // and the last point of the (extended) left side to the right side
      left.push(right[0]!)
      right.push(left[left.length - 1]!)
      result.push(createRotatedBoundingBox(Int32Array.from(left.flat()), remaining.debugId))
      remaining = createRotatedBoundingBox(Int32Array.from(right.flat()), remaining.debugId)
    }
    result.push(remaining)
  }
  return result
}

const isShortLine = (unitSize: number) => unitSize / 5
const isShortConnectedLine = (unitSize: number) => 2 * unitSize
const maxLineGapSize = (unitSize: number) => 5 * unitSize
const staffLineSegmentXTolerance = 10
const maxAngleForLinesToBeParallel = 10

/** Python's set(boxes): box equality, so a set of keys. */
const keySet = (boxes: readonly AngledBoundingBox[]) => new Set(boxes.map((b) => b.key()))
const isSubset = (a: Set<string>, b: Set<string>) => [...a].every((k) => b.has(k))

/** Python's list.remove: removes the first element equal to `item`. */
function removeFirstEqual<T extends AngledBoundingBox>(list: T[], item: T): void {
  const i = list.findIndex((x) => x.equals(item))
  if (i < 0) throw new Error('list.remove(x): x not in list')
  list.splice(i, 1)
}

export class StaffLineSegment {
  readonly staffFragments: RotatedBoundingBox[]
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number

  constructor(
    readonly debugId: number,
    staffFragments: RotatedBoundingBox[],
  ) {
    this.staffFragments = [...staffFragments].sort((a, b) => a.box[0][0] - b.box[0][0])
    this.minX = Math.min(...staffFragments.map((l) => l.center[0] - l.size[0] / 2))
    this.maxX = Math.max(...staffFragments.map((l) => l.center[0] + l.size[0] / 2))
    this.minY = Math.min(...staffFragments.map((l) => l.center[1] - l.size[1] / 2))
    this.maxY = Math.max(...staffFragments.map((l) => l.center[1] + l.size[1] / 2))
  }

  merge(other: StaffLineSegment): StaffLineSegment {
    const lines = [...this.staffFragments]
    for (const fragment of other.staffFragments) {
      if (!lines.some((l) => l.equals(fragment))) lines.push(fragment)
    }
    return new StaffLineSegment(this.debugId, lines)
  }

  getAt(x: number): RotatedBoundingBox | undefined {
    const tolerance = staffLineSegmentXTolerance
    return this.staffFragments.find(
      (f) => x >= f.center[0] - f.size[0] / 2 - tolerance && x <= f.center[0] + f.size[0] / 2 + tolerance,
    )
  }

  isOverlapping(other: StaffLineSegment): boolean {
    return this.staffFragments.some((line) => other.staffFragments.some((o) => line.isOverlapping(o)))
  }
}

/**
 * A reliable staff: five parallel lines which, by their relation to other symbols, likely
 * belong to a staff.
 */
export class StaffAnchor {
  readonly unitSizes: number[]
  readonly averageUnitSize: number
  readonly maxY: number
  readonly minY: number
  /** range(start, stop) */
  readonly zone: { start: number; stop: number }

  constructor(
    readonly staffLines: StaffLineSegment[],
    readonly symbol: RotatedBoundingBox,
  ) {
    const yPositions = staffLines
      .map((line) => line.staffFragments[0]!.getCenterExtrapolated(symbol.center[0]))
      .sort((a, b) => a - b)
    this.unitSizes = yPositions.slice(1).map((y, i) => Math.abs(y - yPositions[i]!))
    this.averageUnitSize = this.unitSizes.length === 0 ? 0 : mean(this.unitSizes)
    this.maxY = Math.max(...staffLines.map((l) => l.maxY))
    this.minY = Math.min(...staffLines.map((l) => l.minY))
    const maxNumberOfLedgerLines = 5
    this.zone = {
      start: Math.trunc(this.minY - maxNumberOfLedgerLines * this.averageUnitSize),
      stop: Math.trunc(this.maxY + maxNumberOfLedgerLines * this.averageUnitSize),
    }
  }
}

function allContours(lines: StaffLineSegment[]): Contour {
  return concatContours(lines.flatMap((line) => line.staffFragments.map((f) => f.contours)))
}

/** A staff made of the parts found on the image, with gaps and ragged line ends. */
export class RawStaff extends RotatedBoundingBox {
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number

  constructor(
    readonly staffId: number,
    readonly lines: StaffLineSegment[],
    readonly anchors: StaffAnchor[],
  ) {
    const contours = allContours(lines)
    super(minAreaRect(contours), contours, staffId)
    this.minX = this.center[0] - this.size[0] / 2
    this.maxX = this.center[0] + this.size[0] / 2
    this.minY = this.center[1] - this.size[1] / 2
    this.maxY = this.center[1] + this.size[1] / 2
  }

  merge(other: RawStaff): RawStaff {
    const lines = this.lines.map((line, i) => other.lines[i]!.merge(line))
    return new RawStaff(this.staffId, lines, [...this.anchors, ...other.anchors])
  }
}

function getStaffForAnchor(anchor: StaffAnchor, staffs: RawStaff[]): RawStaff | undefined {
  for (const staff of staffs) {
    for (let i = 0; i < anchor.staffLines.length; i++) {
      const requirement = keySet(anchor.staffLines[i]!.staffFragments)
      if (isSubset(requirement, keySet(staff.lines[i]!.staffFragments))) return staff
    }
  }
  return undefined
}

export function findRawStaffsByConnectingLineFragments(
  anchors: StaffAnchor[],
  staffFragments: RotatedBoundingBox[],
): RawStaff[] {
  const staffs: RawStaff[] = []
  let staffId = 0
  for (const anchor of anchors) {
    const existing = getStaffForAnchor(anchor, staffs)
    const fragments = staffFragments.filter(
      (f) => f.center[1] >= anchor.zone.start && f.center[1] <= anchor.zone.stop,
    )
    const connected = connectStaffLines(fragments, anchor.averageUnitSize)
    const staffLines: StaffLineSegment[] = []
    for (const anchorLine of anchor.staffLines) {
      const requirement = keySet(anchorLine.staffFragments)
      const matching = connected.filter((line) => isSubset(requirement, keySet(line.staffFragments)))
      if (matching.length === 1) staffLines.push(...matching)
      else staffLines.push(anchorLine)
    }
    if (existing) {
      removeFirstEqual(staffs, existing)
      staffs.push(existing.merge(new RawStaff(staffId, staffLines, [anchor])))
    } else {
      staffs.push(new RawStaff(staffId, staffLines, [anchor]))
    }
    staffId++
  }
  return staffs
}

/** Sometimes the same staff is found twice without being connected; keeps one of them. */
export function removeDuplicateStaffs(staffs: RawStaff[]): RawStaff[] {
  let result: RawStaff[] = []
  for (const staff of staffs) {
    const overlapping = result.filter((other) => staff.isOverlapping(other))
    if (overlapping.length === 0) {
      result.push(staff)
      continue
    }
    if (overlapping.length >= 2) continue
    if (overlapping[0]!.anchors.length < staff.anchors.length) {
      // The staff with the most anchors is the most reliable one
      result = result.filter((s) => !s.equals(overlapping[0]))
      result.push(staff)
    }
  }
  return result
}

/** True if most columns between the staffs have ink, unlike the gutter between book pages. */
function gapHasInk(left: RawStaff, right: RawStaff, ink: Mask): boolean {
  const x0 = Math.max(Math.trunc(left.maxX), 0)
  const x1 = Math.trunc(right.minX)
  const y0 = Math.max(Math.trunc(Math.min(left.minY, right.minY)), 0)
  const y1 = Math.trunc(Math.max(left.maxY, right.maxY))
  if (x1 <= x0) return true
  // numpy slicing clips to the image
  const xEnd = Math.min(x1, ink.width)
  const yEnd = Math.min(y1, ink.height)
  const columns = xEnd - x0
  if (columns <= 0) return false // the mean of nothing is NaN, which is not >= 0.5
  let withInk = 0
  for (let x = x0; x < xEnd; x++) {
    for (let y = y0; y < yEnd; y++) {
      if (ink.data[y * ink.width + x]! > 0) {
        withInk++
        break
      }
    }
  }
  return withInk / columns >= 0.5
}

/** True if right continues left in the same row: a short gap and the lines line up. */
function continues(left: RawStaff, right: RawStaff): boolean {
  const anchors = [...left.anchors, ...right.anchors]
  const unitSize = mean(anchors.map((a) => a.averageUnitSize))
  const gap = right.minX - left.maxX
  if (unitSize <= 0 || gap < 0 || gap > 15 * unitSize) return false
  if (left.lines.length !== right.lines.length) throw new Error('zip() arguments differ in length')
  let linesWhichLineUp = 0
  left.lines.forEach((leftLine, i) => {
    const rightLine = right.lines[i]!
    const leftEnd = leftLine.staffFragments[leftLine.staffFragments.length - 1]!
    const rightStart = rightLine.staffFragments[0]!
    const leftY = leftEnd.getCenterExtrapolated(leftLine.maxX)
    const rightY = rightStart.getCenterExtrapolated(rightLine.minX)
    if (Math.abs(leftY - rightY) <= unitSize / 2) linesWhichLineUp++
  })
  return linesWhichLineUp >= numberOfLinesOnAStaff - 1
}

/** Merges staffs which the line tracking broke in two, e.g. at a clef change. */
export function mergeStaffsInSameRow(staffs: RawStaff[], ink?: Mask): RawStaff[] {
  const result = [...staffs].sort((a, b) => a.minX - b.minX)
  let i = 0
  while (i < result.length) {
    const current = result[i]!
    const right = result.slice(i + 1).find((other) => continues(current, other) && (!ink || gapHasInk(current, other, ink)))
    if (!right) {
      i++
      continue
    }
    const merged = current.merge(right)
    removeFirstEqual(result, right)
    result[i] = merged
  }
  return result
}

/**
 * Connects fragments which continue each other (extrapolating over gaps) into
 * StaffLineSegments, which likely belong to a staff.
 */
export function connectStaffLines(staffLines: RotatedBoundingBox[], unitSize: number): StaffLineSegment[] {
  // Popping from the end goes from left to right
  const sortedRightToLeft = [...staffLines].sort((a, b) => b.bottomLeft[0] - a.bottomLeft[0])
  const result: RotatedBoundingBox[][] = []
  let active: RotatedBoundingBox[][] = []
  let lastCleanupAtX = 0
  while (sortedRightToLeft.length > 0) {
    const current = sortedRightToLeft.pop()!
    const x = current.bottomLeft[0]
    if (x - lastCleanupAtX > maxLineGapSize(unitSize)) {
      // Line ends too far left of the current fragment will never connect anymore
      active = active.filter((item) => x - item[item.length - 1]!.bottomRight[0] < maxLineGapSize(unitSize))
      lastCleanupAtX = x
    }
    if (current.box[1][0] < isShortLine(unitSize)) continue
    let connected = false
    for (const line of active) {
      if (line[line.length - 1]!.isOverlappingExtrapolated(current, unitSize)) {
        line.push(current)
        connected = true
      }
    }
    if (!connected) {
      const newList = [current]
      result.push(newList)
      active.push(newList)
    }
  }
  const topToBottom = [...result].sort((a, b) => a[0]!.box[0][1] - b[0]!.box[0][1])
  return topToBottom.map((lines, i) => new StaffLineSegment(i, lines))
}

function extrapolatedLineY(line: StaffLineSegment, x: number): number {
  const fragment = line.getAt(x) ?? line.staffFragments[0]!
  return fragment.getCenterExtrapolated(x)
}

/** Whether the vertical order of two lines flips somewhere across their shared x range. */
export function areLinesCrossing(lines: StaffLineSegment[]): boolean {
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const start = Math.max(lines[i]!.minX, lines[j]!.minX)
      const stop = Math.min(lines[i]!.maxX, lines[j]!.maxX)
      if (start >= stop) continue
      const deltaStart = extrapolatedLineY(lines[i]!, start) - extrapolatedLineY(lines[j]!, start)
      const deltaStop = extrapolatedLineY(lines[i]!, stop) - extrapolatedLineY(lines[j]!, stop)
      if (deltaStart === 0 || deltaStop === 0 || deltaStart > 0 !== deltaStop > 0) return true
    }
  }
  return false
}

export function areLinesParallel(lines: StaffLineSegment[], unitSize: number): boolean {
  const fragments = lines.flatMap((line) => line.staffFragments)
  if (fragments.length === 0) return false
  const averageAngle = mean(fragments.map((f) => f.angle))
  return !fragments.some(
    (f) => Math.abs(f.angle - averageAngle) > maxAngleForLinesToBeParallel && f.size[0] > isShortConnectedLine(unitSize),
  )
}

function beginsOrEndsOnOneStaffLine(line: RotatedBoundingBox, staffLines: StaffLineSegment[], unitSize: number): boolean {
  for (const staffLine of staffLines) {
    const fragment = staffLine.getAt(line.center[0])
    if (!fragment) continue
    const staffY = fragment.getCenterExtrapolated(line.center[0])
    if (Math.abs(staffY - line.center[1]) < unitSize) return true
  }
  return false
}

/**
 * Finds staff anchors: five parallel lines which go over or are interrupted by symbols which
 * are always on staffs (and never above or below them like notes can be).
 */
export function findStaffAnchors(
  staffLines: RotatedBoundingBox[],
  anchorSymbols: RotatedBoundingBox[],
  areClefs = false,
): StaffAnchor[] {
  const result: StaffAnchor[] = []
  for (const centerSymbol of anchorSymbols) {
    // The symbol interrupts the lines at its center, so also look left and right of it
    const offsets = areClefs ? [-10, 0, 10, 30, 60, 80] : [-10, -5, 0, 5, 10]
    const adjacent = offsets.map((dx) => (dx === 0 ? centerSymbol : centerSymbol.moveToXHorizontalBy(dx)))
    for (const symbol of adjacent) {
      const estimatedUnitSize = pyRound(symbol.size[1] / (numberOfLinesOnAStaff - 1))
      const thickened = symbol.makeBoxTaller(estimatedUnitSize)
      const overlapping = staffLines.filter((line) => line.isIntersecting(thickened))
      let connected = connectStaffLines(overlapping, estimatedUnitSize)
      if (connected.length > numberOfLinesOnAStaff) {
        connected = connected.filter((line) => line.maxX - line.minX > isShortConnectedLine(estimatedUnitSize))
      }
      if (connected.length !== numberOfLinesOnAStaff) continue
      if (!areLinesParallel(connected, estimatedUnitSize)) continue
      if (areLinesCrossing(connected)) continue
      if (!areClefs && !beginsOrEndsOnOneStaffLine(symbol, connected, estimatedUnitSize)) continue
      result.push(new StaffAnchor(connected, symbol))
    }
  }
  return result
}

/** range(start, stop, step) as an array; negative steps count down. */
function pyRange(start: number, stop: number, step: number): number[] {
  const out: number[] = []
  if (step > 0) for (let v = start; v < stop; v += step) out.push(v)
  else for (let v = start; v > stop; v += step) out.push(v)
  return out
}

function* resampleStaffSegment(anchor: StaffAnchor, staff: RawStaff, axisRange: Iterable<number>): Generator<StaffPoint> {
  const anchorX = anchor.symbol.center[0]
  const lineFragments = anchor.staffLines.map((line) => line.staffFragments[0]!)
  const centers = lineFragments.map((line) => line.getCenterExtrapolated(anchorX))
  // A point at the anchor to start from
  let previous = new StaffPoint(anchorX, centers, mean(lineFragments.map((l) => l.angle)))
  for (const x of axisRange) {
    const lines = staff.lines.map((line) => line.getAt(x))
    const axisCenter: Array<number | undefined> = lines.map((line) => line?.getCenterExtrapolated(x))
    const centerValues = axisCenter.filter((c): c is number => c !== undefined)
    if (axisCenter.every((c) => c === undefined)) continue
    // Like homr, the indices of the present values are used on the list with gaps
    diff(centerValues).forEach((delta, i) => {
      if (delta < 0.5 * anchor.averageUnitSize) {
        axisCenter[i] = undefined
        axisCenter[i + 1] = undefined
      }
    })
    previous.y.forEach((previousY, i) => {
      const value = axisCenter[i]
      if (value !== undefined && Math.abs(value - previousY) > 0.5 * anchor.averageUnitSize) axisCenter[i] = undefined
    })
    let prevCenter = -1
    const indices = axisCenter.map((_, i) => i)
    for (const i of [...indices, ...[...indices].reverse()]) {
      if (axisCenter[i] !== undefined) {
        prevCenter = i
      } else if (prevCenter >= 0) {
        const value = axisCenter[prevCenter]
        if (value !== undefined) axisCenter[i] = value + anchor.averageUnitSize * (i - prevCenter)
      }
    }
    if (axisCenter.some((c) => c === undefined)) continue
    const angle = mean(lines.filter((l): l is RotatedBoundingBox => l !== undefined).map((l) => l.angle))
    previous = new StaffPoint(x, axisCenter as number[], angle)
    yield previous
  }
}

/** Python's float floor division. */
const floorDiv = (a: number, b: number) => Math.floor(a / b)

function resampleStaff(staff: RawStaff): Staff {
  const anchors = [...staff.anchors].sort((a, b) => a.symbol.center[0] - b.symbol.center[0])
  const density = 10
  const roundToDensity = (x: number) => pyRound(x / density) * density
  const start = floorDiv(staff.minX, density) * density
  const stop = (floorDiv(staff.maxX, density) + 1) * density
  const grid: StaffPoint[] = []
  let x = start
  anchors.forEach((anchor, i) => {
    const toLeft = pyRange(roundToDensity(x), roundToDensity(anchor.symbol.center[0]), density)
    let toRight: number[]
    let toRightStop: number
    if (i < anchors.length - 1) {
      const from = Math.trunc(anchor.symbol.center[0])
      toRightStop = Math.trunc((anchor.symbol.center[0] + anchors[i + 1]!.symbol.center[0]) / 2)
      toRight = pyRange(from, toRightStop, density)
    } else {
      toRightStop = roundToDensity(stop)
      toRight = pyRange(roundToDensity(anchor.symbol.center[0]), toRightStop, density)
    }
    x = toRightStop
    grid.push(...[...resampleStaffSegment(anchor, staff, [...toLeft].reverse())].reverse())
    grid.push(...resampleStaffSegment(anchor, staff, toRight))
  })
  return new Staff(grid)
}

/**
 * Resamples raw staffs so that the y positions of all lines are known at every point,
 * which makes them easier to use in the rest of the pipeline.
 */
export function resampleStaffs(staffs: RawStaff[]): Staff[] {
  return staffs.map(resampleStaff)
}

/** Removes staffs which are outside the page. */
export function filterEdgeOfVision(staffs: Staff[], width: number, height: number): Staff[] {
  const usualWidth = mean(staffs.map((s) => s.maxX - s.minX))
  return staffs.filter((staff) => {
    if (staff.maxY >= height || staff.minY < 0) return false
    const shorterThanUsual = staff.maxX - staff.minX < usualWidth / 2
    const beyondLeft = staff.minX < 0.01 * width
    const beyondRight = staff.maxX > 0.99 * width
    return !((beyondLeft || beyondRight) && shorterThanUsual)
  })
}

/** The horizontal range of the long staffs on the page. */
function mainColumn(extents: Array<[number, number]>): [number, number] {
  const longest = Math.max(...extents.map(([l, r]) => r - l))
  const long = extents.filter(([l, r]) => r - l >= 0.75 * longest)
  return [median(long.map(([l]) => l)), median(long.map(([, r]) => r))]
}

function shareInColumn(left: number, right: number, column: [number, number]): number {
  const inside = Math.min(right, column[1]) - Math.max(left, column[0])
  return right > left ? inside / (right - left) : 0
}

/** The staffs of the left page, if a photo shows two pages side by side. */
function leftPage(staffs: Staff[]): Staff[] {
  const minStaffsPerPage = 2
  const unit = median(staffs.map((s) => s.averageUnitSize))
  for (const split of [...new Set(staffs.map((s) => s.maxX))].sort((a, b) => a - b)) {
    const left = staffs.filter((s) => s.maxX <= split)
    const right = staffs.filter((s) => s.maxX > split)
    if (left.length < minStaffsPerPage || right.length < minStaffsPerPage) continue
    if (Math.min(...right.map((s) => s.minX)) - split < 2 * unit) continue
    const leftWidth = median(left.map((s) => s.maxX - s.minX))
    const rightWidth = median(right.map((s) => s.maxX - s.minX))
    if (leftWidth >= rightWidth / 2) return left
  }
  return staffs
}

/** Removes staffs of a neighbor page, e.g. in a photo of a book. */
export function filterNeighborPage(staffs: Staff[]): Staff[] {
  if (staffs.length === 0) return staffs
  staffs = leftPage(staffs)
  const column = mainColumn(staffs.map((s) => [s.minX, s.maxX]))
  const minWidth = (column[1] - column[0]) / 2
  return staffs.filter((s) => s.maxX - s.minX >= minWidth || shareInColumn(s.minX, s.maxX, column) >= 0.5)
}

export function sortStaffsTopToBottom(staffs: Staff[]): Staff[] {
  return [...staffs].sort((a, b) => a.minY - b.minY)
}

export function filterUnusualAnchors(anchors: StaffAnchor[]): StaffAnchor[] {
  if (anchors.length === 0) return anchors
  const unitSizes = anchors.map((a) => a.averageUnitSize)
  const average = mean(unitSizes)
  const deviation = std(unitSizes)
  return anchors.filter((a) => !(Math.abs(a.averageUnitSize - average) > 3 * deviation))
}

type Range = { start: number; stop: number }

function initZone(clefAnchors: StaffAnchor[], width: number): Range[] {
  const makeRange = (start: number, stop: number): Range => ({
    start: Math.max(Math.trunc(start), 0),
    stop: Math.min(Math.trunc(stop), width),
  })
  // Only right of the clef, the only place where staff lines are expected
  const marginRight = 10
  const ranges = clefAnchors
    .map((c) => makeRange(c.symbol.bottomLeft[0], c.symbol.topRight[0] + marginRight))
    .sort((a, b) => a.start - b.start)
  const result: Range[] = []
  ranges.forEach((r, i) => {
    if (i === 0) {
      result.push(r)
      return
    }
    const last = result[result.length - 1]!
    if (r.start < last.stop) result[result.length - 1] = { start: last.start, stop: r.stop }
    else result.push(r)
  })
  return result
}

/** The group of each peak in homr's filter_line_peaks (its only result homr uses). */
function linePeakGroups(peaks: number[], maxGapRatio = 1.5): number[] {
  const gaps = peaks.slice(1).map((p, i) => p - peaks[i]!)
  const count = Math.max(5, pyRound(peaks.length * 0.2))
  const approxUnit = mean([...gaps].sort((a, b) => a - b).slice(0, count))
  const maxGap = approxUnit * maxGapRatio
  // An invalid peak in front handles the first group
  const extPeaks = [peaks[0]! - maxGap - 1, ...peaks]
  const groups: number[] = []
  let group = -1
  for (let i = 1; i < extPeaks.length; i++) {
    if (extPeaks[i]! - extPeaks[i - 1]! > maxGap) group++
    groups.push(group)
  }
  return groups
}

/** Rows of five lines: for each group, the y of its lines. */
export function findHorizontalLines(image: Mask, zone: Range, unitSize: number, lineThreshold = 0): number[][] {
  // The number of pixels per row, with a 0 added before and after
  const count = new Float64Array(image.height + 2)
  for (let y = 0; y < image.height; y++) {
    let n = 0
    for (let x = zone.start; x < zone.stop; x++) if (image.data[y * image.width + x]! > 0) n++
    // uint16 in homr
    count[y + 1] = n & 0xffff
  }
  const deviation = std(count)
  if (deviation === 0) return []
  const average = mean(count)
  const norm = Array.from(count, (c) => (c - average) / deviation)
  // The distance merges sub-peaks within one line's thickness, see homr's comment
  const centers = findPeaks(norm, { height: lineThreshold, distance: 0.7 * unitSize, prominence: 1 }).map((c) => c - 1)
  if (centers.length < numberOfLinesOnAStaff) return []
  const groups = linePeakGroups(centers)
  const grouped = new Map<number, number[]>()
  centers.forEach((center, i) => {
    const g = groups[i]!
    if (!grouped.has(g)) grouped.set(g, [])
    grouped.get(g)!.push(center)
  })
  return [...grouped.values()].filter((g) => g.length === numberOfLinesOnAStaff).map((g) => [...g].sort((a, b) => a - b))
}

function findFiveLineGroups(image: Mask, zones: Range[], unitSize: number): RotatedBoundingBox[] {
  const result: RotatedBoundingBox[] = []
  for (const zone of zones) {
    for (const group of findHorizontalLines(image, zone, unitSize)) {
      const minY = Math.min(...group)
      const maxY = Math.max(...group)
      const centerY = (minY + maxY) / 2
      const centerX = zone.start + (zone.stop - zone.start) / 2
      result.push(
        new RotatedBoundingBox(
          [[Math.trunc(centerX), Math.trunc(centerY)], [zone.stop - zone.start, Math.trunc(maxY - minY)], 0],
          new Int32Array(0),
          0,
        ),
      )
    }
  }
  return result
}

function predictOtherAnchorsFromClefs(clefAnchors: StaffAnchor[], image: Mask): RotatedBoundingBox[] {
  if (clefAnchors.length === 0) return []
  const averageUnitSize = mean(clefAnchors.map((a) => a.averageUnitSize))
  const anchorSymbols = clefAnchors.map((a) => a.symbol)
  const result = findFiveLineGroups(image, initZone(clefAnchors, image.width), averageUnitSize)
  return result.filter((r) => !r.isOverlappingWithAny(anchorSymbols))
}

// Positions across the page, as fraction of its width, to search for staffs without clef
const slicesAcrossPage = [0.2, 0.35, 0.5, 0.65, 0.8]

/** Finds staffs whose clef and bar lines were missed, by their staff lines alone. */
function findStaffsWithoutClef(
  rawStaffs: RawStaff[],
  clefAnchors: StaffAnchor[],
  staffFragments: RotatedBoundingBox[],
  image: Mask,
): RawStaff[] {
  if (rawStaffs.length === 0 || clefAnchors.length === 0) return []
  const unitSize = mean(clefAnchors.map((a) => a.averageUnitSize))
  const width = image.width
  const sliceWidth = Math.max(10, Math.trunc(2 * unitSize))
  const zones = slicesAcrossPage.map((f) => ({
    start: Math.trunc(f * width),
    stop: Math.min(width, Math.trunc(f * width) + sliceWidth),
  }))
  const boxes = findFiveLineGroups(image, zones, unitSize)
  const anchors = filterUnusualAnchors(findStaffAnchors(staffFragments, boxes, true))
  const candidates = removeDuplicateStaffs(findRawStaffsByConnectingLineFragments(anchors, staffFragments))
  const column = mainColumn(rawStaffs.map((s) => [s.minX, s.maxX]))
  const minWidth = (column[1] - column[0]) / 2
  return candidates.filter(
    (c) =>
      c.maxX - c.minX >= minWidth &&
      shareInColumn(c.minX, c.maxX, column) >= 0.9 &&
      !rawStaffs.some((s) => c.isOverlapping(s)),
  )
}

/** Fallback for pages without noteheads: the unit size from the staff lines around clefs. */
export function estimateUnitSizeFromClefs(
  staffFragments: RotatedBoundingBox[],
  clefsKeys: RotatedBoundingBox[],
): number | undefined {
  const anchors = findStaffAnchors(staffFragments, clefsKeys, true)
  if (anchors.length === 0) return undefined
  return median(anchors.map((a) => a.averageUnitSize))
}

/** Detects the staffs on the image. They can be warped, have gaps and be interrupted by symbols. */
export function detectStaff(
  image: Mask,
  staffFragments: RotatedBoundingBox[],
  clefsKeys: RotatedBoundingBox[],
  likelyBarOrRestsLines: RotatedBoundingBox[],
  symbols?: Mask,
): Staff[] {
  const clefAnchors = findStaffAnchors(staffFragments, clefsKeys, true)
  let anchors = [...clefAnchors]
  const possibleOtherClefs = predictOtherAnchorsFromClefs(clefAnchors, image)
  anchors.push(...findStaffAnchors(staffFragments, possibleOtherClefs, true))
  anchors.push(...findStaffAnchors(staffFragments, likelyBarOrRestsLines, false))
  anchors = filterUnusualAnchors(anchors)

  let rawStaffs = removeDuplicateStaffs(findRawStaffsByConnectingLineFragments(anchors, staffFragments))
  let ink = image
  if (symbols) {
    const data = new Uint8Array(image.data.length)
    for (let i = 0; i < data.length; i++) data[i] = image.data[i]! > 0 || symbols.data[i]! > 0 ? 1 : 0
    ink = { width: image.width, height: image.height, data }
  }
  rawStaffs = mergeStaffsInSameRow(rawStaffs, ink)
  rawStaffs.push(...findStaffsWithoutClef(rawStaffs, clefAnchors, staffFragments, image))

  let staffs = resampleStaffs(rawStaffs)
  staffs = filterEdgeOfVision(staffs, image.width, image.height)
  staffs = filterNeighborPage(staffs)
  return sortStaffsTopToBottom(staffs)
}
